import { fail, ok, type Result } from '../result.ts';
import { transaction } from '../storage/query.ts';

import {
  auditPrefix,
  CREDENTIAL_PREFIX,
  hasCredentialPrefix,
  hashCredential,
} from './credentials.ts';
import { OAuthError, respondRateLimited, respondWithOAuthError } from './errors.ts';
import { type FormFields, readForm, requireField } from './form.ts';
import { canonicalResource } from './metadata.ts';
import { isCodeVerifierFor } from './pkce.ts';
import { enabledScopes, isScopeSubset, parseScopeParameter } from './scopes.ts';
import { type IssuedPair, issueTokenPair, type TokenIssuerOptions } from './token-issuance.ts';

import type { AuditSink, OAuthAuditAction } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { AuthorizationCodeRecord } from './repositories/authorization-codes.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { TokenRecord } from './repositories/tokens.ts';
import type { Context } from 'hono';

const MAX_FORM_BYTES = 16 * 1024;

export interface TokenEndpointDependencies extends Omit<TokenIssuerOptions, 'tokens'> {
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

function issuer(dependencies: TokenEndpointDependencies): TokenIssuerOptions {
  return { ...dependencies, tokens: dependencies.repos.tokens };
}

function isConsentActive(dependencies: TokenEndpointDependencies, consentId: string): boolean {
  const consent = dependencies.repos.consents.findById(consentId);
  return consent !== undefined && consent.revokedAt === undefined;
}

interface CodeRequest {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly resource: string;
}

function readCodeRequest(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): Result<CodeRequest, OAuthError> {
  const values: string[] = [];
  for (const name of ['code', 'client_id', 'redirect_uri', 'code_verifier', 'resource']) {
    const field = requireField(form, name);
    if (!field.ok) {
      return field;
    }
    values.push(field.value);
  }
  const [code = '', clientId = '', redirectUri = '', codeVerifier = '', resource = ''] = values;
  if (resource !== canonicalResource(dependencies.publicUrl)) {
    return fail(new OAuthError('invalid_target', 'resource must be the canonical MCP resource'));
  }
  return hasCredentialPrefix(code, CREDENTIAL_PREFIX.authorizationCode)
    ? ok({ code, clientId, redirectUri, codeVerifier, resource })
    : fail(invalidGrant('the authorization code is invalid'));
}

/**
 * OAUTH-21 / OAUTH-22: a single-statement claim; a second redemption revokes
 * everything the code produced.
 */
function claimCode(
  dependencies: TokenEndpointDependencies,
  code: string,
  at: number,
): Result<AuthorizationCodeRecord, OAuthError> {
  const codeHash = hashCredential(code);
  const claim = dependencies.repos.authorizationCodes.claim(codeHash, at);
  if (claim.kind === 'unknown') {
    return fail(invalidGrant('the authorization code is invalid'));
  }
  if (claim.kind === 'reused') {
    const revoked = dependencies.repos.tokens.revokeFamily(codeHash, at);
    dependencies.audit.record({
      category: 'oauth',
      action: 'token_revoked',
      outcome: 'success',
      clientId: claim.code.clientId,
      tokenPrefix: auditPrefix(code),
      details: { reason: 'authorization code reuse', revoked },
    });
    return fail(invalidGrant('the authorization code has already been used'));
  }
  return ok(claim.code);
}

/**
 * OAUTH-21…23: every bound parameter must match, the code must be live and
 * unused, and the verifier must prove the challenge.
 */
function redeemCode(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): Result<IssuedPair, OAuthError> {
  const request = readCodeRequest(dependencies, form);
  if (!request.ok) {
    return request;
  }
  const at = dependencies.now();
  const claimed = claimCode(dependencies, request.value.code, at);
  if (!claimed.ok) {
    return claimed;
  }
  const stored = claimed.value;
  const isBound =
    stored.expiresAt > at &&
    stored.clientId === request.value.clientId &&
    stored.redirectUri === request.value.redirectUri &&
    stored.resource === request.value.resource &&
    isConsentActive(dependencies, stored.consentId);
  if (!isBound) {
    return fail(invalidGrant('the authorization code does not match this request'));
  }
  if (!isCodeVerifierFor(request.value.codeVerifier, stored.codeChallenge)) {
    return fail(invalidGrant('the PKCE code_verifier does not match'));
  }
  return ok(
    issueTokenPair(issuer(dependencies), {
      clientId: stored.clientId,
      consentId: stored.consentId,
      familyId: stored.codeHash,
      parentId: undefined,
      scopes: stored.scopes,
      resource: request.value.resource,
      refreshExpiresAt: undefined,
    }),
  );
}

function replayed(
  dependencies: TokenEndpointDependencies,
  record: TokenRecord,
  presented: string,
): OAuthError {
  const revoked = dependencies.repos.tokens.revokeFamily(record.familyId, dependencies.now());
  dependencies.audit.record({
    category: 'oauth',
    action: 'token_revoked',
    outcome: 'success',
    clientId: record.clientId,
    tokenPrefix: auditPrefix(presented),
    details: { reason: 'refresh token replay', revoked },
  });
  return invalidGrant('the refresh token has already been used');
}

/**
 * A refresh token is unexpired and, when the client names itself, its own.
 */
function isUsableBy(record: TokenRecord, clientId: string | undefined, at: number): boolean {
  return record.expiresAt > at && (clientId === undefined || clientId === record.clientId);
}

function liveRefreshToken(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): Result<TokenRecord, OAuthError> {
  const presented = requireField(form, 'refresh_token');
  if (!presented.ok) {
    return presented;
  }
  const record = hasCredentialPrefix(presented.value, CREDENTIAL_PREFIX.refreshToken)
    ? dependencies.repos.tokens.findByHash(hashCredential(presented.value))
    : undefined;
  if (record?.kind !== 'refresh' || record.revokedAt !== undefined) {
    return fail(invalidGrant('the refresh token is invalid'));
  }
  if (record.replacedById !== undefined) {
    return fail(replayed(dependencies, record, presented.value));
  }
  if (!isUsableBy(record, form.get('client_id'), dependencies.now())) {
    return fail(invalidGrant('the refresh token is invalid'));
  }
  return isConsentActive(dependencies, record.consentId)
    ? ok(record)
    : fail(invalidGrant('consent has been revoked'));
}

/**
 * OAUTH-25: rotate within the family, never widen scope, revoke the family
 * on replay.
 */
function refresh(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): Result<IssuedPair, OAuthError> {
  const live = liveRefreshToken(dependencies, form);
  if (!live.ok) {
    return live;
  }
  const record = live.value;
  const resource = form.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    return fail(new OAuthError('invalid_target', 'resource does not match the refresh token'));
  }
  const scopes = parseScopeParameter(form.get('scope'), enabledScopes(dependencies));
  if (!scopes.ok) {
    return fail(new OAuthError('invalid_scope', scopes.error.message));
  }
  const requested = form.has('scope') ? scopes.value : record.scopes;
  if (!isScopeSubset(requested, record.scopes)) {
    return fail(new OAuthError('invalid_scope', 'scope cannot be widened on refresh'));
  }
  return transaction(dependencies.repos.db, () => {
    const pair = issueTokenPair(issuer(dependencies), {
      clientId: record.clientId,
      consentId: record.consentId,
      familyId: record.familyId,
      parentId: record.id,
      scopes: requested,
      resource: record.resource ?? canonicalResource(dependencies.publicUrl),
      refreshExpiresAt: record.expiresAt,
    });
    if (!dependencies.repos.tokens.markReplaced(record.id, pair.refreshTokenId)) {
      dependencies.repos.tokens.revokeFamily(record.familyId, dependencies.now());
      return fail(invalidGrant('the refresh token has already been used'));
    }
    return ok(pair);
  });
}

function grant(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): { readonly action: OAuthAuditAction; readonly result: Result<IssuedPair, OAuthError> } {
  switch (form.get('grant_type')) {
    case 'authorization_code': {
      return { action: 'token_issued', result: redeemCode(dependencies, form) };
    }
    case 'refresh_token': {
      return { action: 'token_refreshed', result: refresh(dependencies, form) };
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
export function createTokenHandler(
  dependencies: TokenEndpointDependencies,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const ip = dependencies.clientIp(context.req.raw);
    const limit = dependencies.rateLimiter.take(ip);
    if (!limit.allowed) {
      return respondRateLimited(context, limit.retryAfterSeconds);
    }
    const form = await readForm(context.req.raw, MAX_FORM_BYTES);
    if (!form.ok) {
      return respondWithOAuthError(context, form.error);
    }
    const { action, result } = grant(dependencies, form.value);
    if (!result.ok) {
      return respondWithOAuthError(context, result.error);
    }
    dependencies.audit.record({
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
