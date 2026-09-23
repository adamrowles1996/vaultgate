import {
  auditPrefix,
  CREDENTIAL_PREFIX,
  hasCredentialPrefix,
  hashCredential,
} from './credentials.ts';
import { respondRateLimited, respondWithOAuthError } from './errors.ts';
import { readForm, requireField } from './form.ts';

import type { OAuthAuditSink } from './audit.ts';
import type { Clock } from './clock.ts';
import type { ConnectedClient } from './repositories/consents.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { ClientIpResolver, OAuthContext, OAuthHandler } from './request-context.ts';
import type { Guards } from '../identity/guards.ts';
import type { RateLimiter } from '../net/rate-limit.ts';

const MAX_FORM_BYTES = 16 * 1024;

export interface RevocationDependencies {
  readonly repos: OAuthRepos;
  readonly audit: OAuthAuditSink;
  readonly now: Clock;
  readonly clientIp: ClientIpResolver;
  readonly guards: Guards;
  /**
  ACT-10: told the client id once its consent is revoked, so the actions layer can drop its grants and sessions; wired by composition, never imported.
  */
  readonly onConsentRevoked?: ((clientId: string) => void) | undefined;
}

export interface RevokeEndpointDependencies extends RevocationDependencies {
  /**
  60 per minute per ip, as the token endpoint (spec §10.4).
  */
  readonly rateLimiter: RateLimiter;
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
    outcome: 'ok',
    clientId: record.clientId,
    tokenPrefix: auditPrefix(token),
    ip,
    details: { kind: record.kind, revoked },
  });
}

/**
 * `POST /oauth/revoke` (RFC 7009): `200 {}` whether or not the token existed,
 * behind the same per-ip limit as the token endpoint.
 */
export function createRevokeHandler(dependencies: RevokeEndpointDependencies): OAuthHandler {
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
    const token = requireField(form.value, 'token');
    if (!token.ok) {
      return respondWithOAuthError(context, token.error);
    }
    revokeToken(dependencies, token.value, ip);
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
  dependencies: Pick<RevocationDependencies, 'repos' | 'audit' | 'now' | 'onConsentRevoked'>,
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
  dependencies.onConsentRevoked?.(consent.clientId);
  dependencies.audit.record({
    category: 'oauth',
    action: 'consent_revoked',
    outcome: 'ok',
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

/**
 * `POST /oauth/consents/:id/revoke` (OAUTH-30), the account page's
 * "Disconnect" button: the session and ID-18 checks of every account action,
 * then the ID-15 re-authentication window of every sensitive one.
 */
export type ConsentRevokeHandler = (context: OAuthContext, consentId: string) => Promise<Response>;

export function createConsentRevokeHandler(
  dependencies: RevocationDependencies,
): ConsentRevokeHandler {
  return async (context, consentId) => {
    const session = context.get('session');
    if (session === undefined) {
      return dependencies.guards.deny(context, 'no session');
    }
    const form = await readForm(context.req.raw, MAX_FORM_BYTES);
    const fields = form.ok ? form.value : new Map<string, string>();
    const denied = dependencies.guards.stateChange(context, fields, session.csrfToken);
    if (denied !== undefined) {
      return denied;
    }
    if (!session.isReauthenticated) {
      return dependencies.guards.deny(context, 're-authentication required');
    }
    return revokeConsent(dependencies, session.operatorId, consentId) === undefined
      ? dependencies.guards.deny(context, 'unknown consent')
      : context.redirect('/account', 303);
  };
}
