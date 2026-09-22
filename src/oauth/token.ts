import { transaction } from '../storage/query.ts';
import { fail, ok, type Result } from '../result.ts';

import { auditPrefix, CREDENTIAL_PREFIX, hasCredentialPrefix, hashCredential } from './credentials.ts';
import { OAuthError, respondRateLimited, respondWithOAuthError } from './errors.ts';
import { type FormFields, readForm, requireField } from './form.ts';
import { canonicalResource } from './metadata.ts';
import { isCodeVerifierFor } from './pkce.ts';
import { enabledScopes, isScopeSubset, parseScopeParameter } from './scopes.ts';
import { type IssuedPair, issueTokenPair, type TokenIssuerOptions } from './token-issuance.ts';

import type { Context } from 'hono';
import type { AuditSink, OAuthAuditAction } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { TokenRecord } from './repositories/tokens.ts';

const MAX_FORM_BYTES = 16 * 1024;

export interface TokenEndpointDeps extends Omit<TokenIssuerOptions, 'tokens'> {
  readonly publicUrl: string;
  readonly enableWriteScope: boolean;
  readonly repos: OAuthRepos;
  readonly audit: AuditSink;
  /**
  60 per minute per ip (OAUTH-28).
  */
  readonly rateLimiter: RateLimiter;
  readonly clientIp: ClientIpResolver;
}

function invalidGrant(description: string): OAuthError {
  return new OAuthError('invalid_grant', description);
}

function issuer(deps: TokenEndpointDeps): TokenIssuerOptions {
  return { ...deps, tokens: deps.repos.tokens };
}

function isConsentActive(deps: TokenEndpointDeps, consentId: string): boolean {
  const consent = deps.repos.consents.findById(consentId);
  return consent !== undefined && consent.revokedAt === undefined;
}

/**
 * OAUTH-21…23: every bound parameter must match, the code must be live and
 * unused, and the verifier must prove the challenge.
 */
function redeemCode(deps: TokenEndpointDeps, form: FormFields): Result<IssuedPair, OAuthError> {
  const fields = ['code', 'client_id', 'redirect_uri', 'code_verifier', 'resource'].map((name) =>
    requireField(form, name),
  );
  const missing = fields.find((field) => !field.ok);
  if (missing !== undefined && !missing.ok) {
    return fail(missing.error);
  }
  const [code, clientId, redirectUri, codeVerifier, resource] = fields.map((field) =>
    field.ok ? field.value : '',
  );
  if (resource !== canonicalResource(deps.publicUrl)) {
    return fail(new OAuthError('invalid_target', 'resource must be the canonical MCP resource'));
  }
  if (code === undefined || !hasCredentialPrefix(code, CREDENTIAL_PREFIX.authorizationCode)) {
    return fail(invalidGrant('the authorization code is invalid'));
  }
  const codeHash = hashCredential(code);
  const at = deps.now();
  const claim = deps.repos.authorizationCodes.claim(codeHash, at);
  if (claim.kind === 'unknown') {
    return fail(invalidGrant('the authorization code is invalid'));
  }
  if (claim.kind === 'reused') {
    const revoked = deps.repos.tokens.revokeFamily(codeHash, at);
    deps.audit.record({
      category: 'oauth',
      action: 'token_revoked',
      outcome: 'success',
      clientId: claim.code.clientId,
      tokenPrefix: auditPrefix(code),
      details: { reason: 'authorization code reuse', revoked },
    });
    return fail(invalidGrant('the authorization code has already been used'));
  }
  const stored = claim.code;
  const bound =
    stored.expiresAt > at &&
    stored.clientId === clientId &&
    stored.redirectUri === redirectUri &&
    stored.resource === resource &&
    isConsentActive(deps, stored.consentId);
  if (!bound) {
    return fail(invalidGrant('the authorization code does not match this request'));
  }
  if (codeVerifier === undefined || !isCodeVerifierFor(codeVerifier, stored.codeChallenge)) {
    return fail(invalidGrant('the PKCE code_verifier does not match'));
  }
  return ok(
    issueTokenPair(issuer(deps), {
      clientId: stored.clientId,
      consentId: stored.consentId,
      familyId: codeHash,
      parentId: undefined,
      scopes: stored.scopes,
      resource,
      refreshExpiresAt: undefined,
    }),
  );
}

function liveRefreshToken(
  deps: TokenEndpointDeps,
  form: FormFields,
): Result<TokenRecord, OAuthError> {
  const presented = requireField(form, 'refresh_token');
  if (!presented.ok) {
    return fail(presented.error);
  }
  if (!hasCredentialPrefix(presented.value, CREDENTIAL_PREFIX.refreshToken)) {
    return fail(invalidGrant('the refresh token is invalid'));
  }
  const record = deps.repos.tokens.findByHash(hashCredential(presented.value));
  const at = deps.now();
  if (record === undefined || record.kind !== 'refresh' || record.revokedAt !== undefined) {
    return fail(invalidGrant('the refresh token is invalid'));
  }
  if (record.replacedById !== undefined) {
    const revoked = deps.repos.tokens.revokeFamily(record.familyId, at);
    deps.audit.record({
      category: 'oauth',
      action: 'token_revoked',
      outcome: 'success',
      clientId: record.clientId,
      tokenPrefix: auditPrefix(presented.value),
      details: { reason: 'refresh token replay', revoked },
    });
    return fail(invalidGrant('the refresh token has already been used'));
  }
  const clientId = form.get('client_id');
  if (record.expiresAt <= at || (clientId !== undefined && clientId !== record.clientId)) {
    return fail(invalidGrant('the refresh token is invalid'));
  }
  return isConsentActive(deps, record.consentId)
    ? ok(record)
    : fail(invalidGrant('consent has been revoked'));
}

/**
 * OAUTH-25: rotate within the family, never widen scope, revoke the family
 * on replay.
 */
function refresh(deps: TokenEndpointDeps, form: FormFields): Result<IssuedPair, OAuthError> {
  const live = liveRefreshToken(deps, form);
  if (!live.ok) {
    return live;
  }
  const record = live.value;
  const resource = form.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    return fail(new OAuthError('invalid_target', 'resource does not match the refresh token'));
  }
  const scopes = parseScopeParameter(form.get('scope'), enabledScopes(deps));
  if (!scopes.ok) {
    return fail(new OAuthError('invalid_scope', scopes.error.message));
  }
  const requested = form.get('scope') === undefined ? record.scopes : scopes.value;
  if (!isScopeSubset(requested, record.scopes)) {
    return fail(new OAuthError('invalid_scope', 'scope cannot be widened on refresh'));
  }
  return transaction(deps.repos.db, () => {
    const pair = issueTokenPair(issuer(deps), {
      clientId: record.clientId,
      consentId: record.consentId,
      familyId: record.familyId,
      parentId: record.id,
      scopes: requested,
      resource: record.resource ?? canonicalResource(deps.publicUrl),
      refreshExpiresAt: record.expiresAt,
    });
    if (!deps.repos.tokens.markReplaced(record.id, pair.refreshTokenId)) {
      deps.repos.tokens.revokeFamily(record.familyId, deps.now());
      return fail(invalidGrant('the refresh token has already been used'));
    }
    return ok(pair);
  });
}

function grant(
  deps: TokenEndpointDeps,
  form: FormFields,
): { readonly action: OAuthAuditAction; readonly result: Result<IssuedPair, OAuthError> } {
  switch (form.get('grant_type')) {
    case 'authorization_code': {
      return { action: 'token_issued', result: redeemCode(deps, form) };
    }
    case 'refresh_token': {
      return { action: 'token_refreshed', result: refresh(deps, form) };
    }
    default: {
      return {
        action: 'token_issued',
        result: fail(new OAuthError('unsupported_grant_type', 'grant_type is not supported')),
      };
    }
  }
}

/**
 * `POST /oauth/token` (OAUTH-21…28).
 */
export function createTokenHandler(deps: TokenEndpointDeps): (context: Context) => Promise<Response> {
  return async (context) => {
    const ip = deps.clientIp(context.req.raw);
    const limit = deps.rateLimiter.take(ip);
    if (!limit.allowed) {
      return respondRateLimited(context, limit.retryAfterSeconds);
    }
    const form = await readForm(context.req.raw, MAX_FORM_BYTES);
    if (!form.ok) {
      return respondWithOAuthError(context, form.error);
    }
    const { action, result } = grant(deps, form.value);
    if (!result.ok) {
      return respondWithOAuthError(context, result.error);
    }
    deps.audit.record({
      category: 'oauth',
      action,
      outcome: 'success',
      clientId: form.value.get('client_id') ?? '',
      tokenPrefix: auditPrefix(result.value.response.access_token),
      requestId: context.req.header('x-request-id'),
      ip,
      details: { scopes: result.value.response.scope.split(' ') },
    });
    context.header('Cache-Control', 'no-store');
    context.header('Pragma', 'no-cache');
    return context.json(result.value.response, 200);
  };
}
