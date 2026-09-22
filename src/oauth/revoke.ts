import {
  auditPrefix,
  CREDENTIAL_PREFIX,
  hasCredentialPrefix,
  hashCredential,
} from './credentials.ts';
import { respondWithOAuthError } from './errors.ts';
import { readForm, requireField } from './form.ts';

import type { AuditSink } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { Clock } from './clock.ts';
import type { ConnectedClient } from './repositories/consents.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { Context } from 'hono';

const MAX_FORM_BYTES = 16 * 1024;

export interface RevocationDependencies {
  readonly repos: OAuthRepos;
  readonly audit: AuditSink;
  readonly now: Clock;
  readonly clientIp: ClientIpResolver;
}

/**
 * OAUTH-29: an access token revokes itself; a refresh token revokes its
 * whole family. Anything else is a silent no-op.
 */
function revokeToken(dependencies: RevocationDependencies, token: string, ip: string): void {
  const isAccess = hasCredentialPrefix(token, CREDENTIAL_PREFIX.accessToken);
  const isRefresh = hasCredentialPrefix(token, CREDENTIAL_PREFIX.refreshToken);
  if (!isAccess && !isRefresh) {
    return;
  }
  const record = dependencies.repos.tokens.findByHash(hashCredential(token));
  if (record === undefined) {
    return;
  }
  const at = dependencies.now();
  const revoked =
    record.kind === 'refresh'
      ? dependencies.repos.tokens.revokeFamily(record.familyId, at)
      : dependencies.repos.tokens.revokeById(record.id, at);
  dependencies.audit.record({
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
export function createRevokeHandler(
  dependencies: RevocationDependencies,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const form = await readForm(context.req.raw, MAX_FORM_BYTES);
    if (!form.ok) {
      return respondWithOAuthError(context, form.error);
    }
    const token = requireField(form.value, 'token');
    if (!token.ok) {
      return respondWithOAuthError(context, token.error);
    }
    revokeToken(dependencies, token.value, dependencies.clientIp(context));
    context.header('Cache-Control', 'no-store');
    return context.json({}, 200);
  };
}

/**
 * OAUTH-30: revoking a consent revokes every token issued under it. Yields
 * the number of tokens revoked, or `undefined` when the consent was unknown,
 * already revoked or not the operator's.
 */
export function revokeConsent(
  dependencies: Pick<RevocationDependencies, 'repos' | 'audit' | 'now'>,
  operatorId: string,
  consentId: string,
): number | undefined {
  const consent = dependencies.repos.consents.findById(consentId);
  if (consent?.operatorId !== operatorId) {
    return undefined;
  }
  const at = dependencies.now();
  if (dependencies.repos.consents.revoke(consentId, at) === 0) {
    return undefined;
  }
  const revoked = dependencies.repos.tokens.revokeByConsent(consentId, at);
  dependencies.audit.record({
    category: 'oauth',
    action: 'consent_revoked',
    outcome: 'success',
    operatorId,
    clientId: consent.clientId,
    details: { revoked },
  });
  return revoked;
}

export function listConnectedClients(
  dependencies: Pick<RevocationDependencies, 'repos'>,
  operatorId: string,
): readonly ConnectedClient[] {
  return dependencies.repos.consents.listConnected(operatorId);
}
