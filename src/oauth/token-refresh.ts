import { fail, ok, type Result } from '../result.ts';
import { enabledScopes } from '../scopes/registry.ts';
import { transaction } from '../storage/query.ts';

import {
  auditPrefix,
  CREDENTIAL_PREFIX,
  hasCredentialPrefix,
  hashCredential,
} from './credentials.ts';
import { OAuthError } from './errors.ts';
import { type FormFields, requireField } from './form.ts';
import { isScopeSubset, parseScopeParameter } from './scopes.ts';
import { type IssuedPair, issueTokenPair } from './token-issuance.ts';
import {
  invalidGrant,
  isConsentActive,
  issuer,
  type TokenEndpointDependencies,
} from './token-shared.ts';

import type { TokenRecord } from './repositories/tokens.ts';

function replayed(
  dependencies: TokenEndpointDependencies,
  record: TokenRecord,
  presented: string,
): OAuthError {
  const revoked = dependencies.repos.tokens.revokeFamily(record.familyId, dependencies.now());
  dependencies.audit.record({
    category: 'oauth',
    action: 'token_revoked',
    outcome: 'ok',
    clientId: record.clientId,
    tokenPrefix: auditPrefix(presented),
    details: { reason: 'refresh token replay', revoked },
  });
  return invalidGrant('the refresh token has already been used');
}

/**
 * A refresh token is unexpired and belongs to the client presenting it.
 */
function isUsableBy(record: TokenRecord, clientId: string, at: number): boolean {
  return record.expiresAt > at && clientId === record.clientId;
}

/**
 * OAUTH-25: `refresh_token` and `client_id` are both required; a public
 * client always names itself (OAuth 2.1 §3.2.2), and the token is bound to
 * that name exactly as an authorization code is.
 */
function liveRefreshToken(
  dependencies: TokenEndpointDependencies,
  form: FormFields,
): Result<TokenRecord, OAuthError> {
  const presented = requireField(form, 'refresh_token');
  if (!presented.ok) {
    return presented;
  }
  const clientId = requireField(form, 'client_id');
  if (!clientId.ok) {
    return clientId;
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
  if (!isUsableBy(record, clientId.value, dependencies.now())) {
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
export function refresh(
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
      resource: record.resource,
      refreshExpiresAt: record.expiresAt,
    });
    if (!dependencies.repos.tokens.markReplaced(record.id, pair.refreshTokenId)) {
      dependencies.repos.tokens.revokeFamily(record.familyId, dependencies.now());
      return fail(invalidGrant('the refresh token has already been used'));
    }
    return ok(pair);
  });
}
