import { fail, ok, type Result } from '../result.ts';

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
import { type IssuedPair, issueTokenPair } from './token-issuance.ts';
import { refresh } from './token-refresh.ts';
import {
  invalidGrant,
  isConsentActive,
  issuer,
  type TokenEndpointDependencies,
} from './token-shared.ts';

import type { OAuthAuditAction } from './audit.ts';
import type { AuthorizationCodeRecord } from './repositories/authorization-codes.ts';
import type { OAuthHandler } from './request-context.ts';

export type { TokenEndpointDependencies } from './token-shared.ts';

const MAX_FORM_BYTES = 16 * 1024;

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
      outcome: 'ok',
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
export function createTokenHandler(dependencies: TokenEndpointDependencies): OAuthHandler {
  return async (context) => {
    const ip = dependencies.clientIp(context);
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
      outcome: 'ok',
      clientId: result.value.clientId,
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
