import { auditPrefix, CREDENTIAL_PREFIX, hasCredentialPrefix, hashCredential } from './credentials.ts';
import { respondWithOAuthError } from './errors.ts';
import { readForm, requireField } from './form.ts';

import type { Context } from 'hono';
import type { AuditSink } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { Clock } from './clock.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { ConnectedClient } from './repositories/consents.ts';

const MAX_FORM_BYTES = 16 * 1024;

export interface RevocationDeps {
  readonly repos: OAuthRepos;
  readonly audit: AuditSink;
  readonly now: Clock;
  readonly clientIp: ClientIpResolver;
}

/**
 * OAUTH-29: an access token revokes itself; a refresh token revokes its
 * whole family. Anything else is a silent no-op.
 */
function revokeToken(deps: RevocationDeps, token: string, ip: string): void {
  const isAccess = hasCredentialPrefix(token, CREDENTIAL_PREFIX.accessToken);
  const isRefresh = hasCredentialPrefix(token, CREDENTIAL_PREFIX.refreshToken);
  if (!isAccess && !isRefresh) {
    return;
  }
  const record = deps.repos.tokens.findByHash(hashCredential(token));
  if (record === undefined) {
    return;
  }
  const at = deps.now();
  const revoked =
    record.kind === 'refresh'
      ? deps.repos.tokens.revokeFamily(record.familyId, at)
      : deps.repos.tokens.revokeById(record.id, at);
  deps.audit.record({
    category: 'oauth',
    action: 'token_revoked',
    outcome: 'success',
    clientId: record.clientId,
    tokenPrefix: auditPrefix(token),
    ip,
    details: { kind: record.kind, revoked },
  });
}

/**
 * `POST /oauth/revoke` (RFC 7009): `200 {}` whether or not the token existed.
 */
export function createRevokeHandler(deps: RevocationDeps): (context: Context) => Promise<Response> {
  return async (context) => {
    const form = await readForm(context.req.raw, MAX_FORM_BYTES);
    if (!form.ok) {
      return respondWithOAuthError(context, form.error);
    }
    const token = requireField(form.value, 'token');
    if (!token.ok) {
      return respondWithOAuthError(context, token.error);
    }
    revokeToken(deps, token.value, deps.clientIp(context.req.raw));
    context.header('Cache-Control', 'no-store');
    return context.json({}, 200);
  };
}

/**
 * OAUTH-30: revoking a consent revokes every token issued under it. Returns
 * false when the consent was unknown, revoked already or not the operator's.
 */
export function revokeConsent(
  deps: Pick<RevocationDeps, 'repos' | 'audit' | 'now'>,
  operatorId: string,
  consentId: string,
): boolean {
  const consent = deps.repos.consents.findById(consentId);
  if (consent?.operatorId !== operatorId) {
    return false;
  }
  const at = deps.now();
  if (deps.repos.consents.revoke(consentId, at) === 0) {
    return false;
  }
  const revoked = deps.repos.tokens.revokeByConsent(consentId, at);
  deps.audit.record({
    category: 'oauth',
    action: 'consent_revoked',
    outcome: 'success',
    operatorId,
    clientId: consent.clientId,
    details: { revoked },
  });
  return true;
}

export function listConnectedClients(
  deps: Pick<RevocationDeps, 'repos'>,
  operatorId: string,
): readonly ConnectedClient[] {
  return deps.repos.consents.listConnected(operatorId);
}
