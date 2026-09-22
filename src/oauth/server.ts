import { fail, ok, type Result } from '../result.ts';

import { createAuthorizeHandler, createConsentPageHandler } from './authorize.ts';
import { createCimdFetcher, type WarnLogger } from './clients/cimd.ts';
import {
  type PreregisteredClientsError,
  validatePreregisteredClients,
} from './clients/preregistered.ts';
import { type ClientResolver, createClientResolver } from './clients/resolve.ts';
import { type Clock, HOUR_MS, MINUTE_MS } from './clock.ts';
import { renderConnectedClients } from './connected-clients.ts';
import { createConsentDecisionHandler } from './consent.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createRegisterHandler } from './register.ts';
import { createOAuthRepos, type OAuthRepos } from './repositories/index.ts';
import { clientIpResolver } from './request-context.ts';
import {
  createConsentRevokeHandler,
  createRevokeHandler,
  listConnectedClients,
  revokeConsent,
} from './revoke.ts';
import { createOAuthRoutes, type OAuthRoutes } from './routes.ts';
import { StoreTokenVerifier } from './token-verifier.ts';
import { createTokenHandler } from './token.ts';

import type { OAuthAuditSink } from './audit.ts';
import type { Config } from '../config/index.ts';
import type { Guards } from '../identity/guards.ts';
import type { Html } from '../identity/pages/template.ts';
import type { SessionState } from '../identity/session-manager.ts';
import type { FetchLike, Lookup } from './clients/ssrf-fetch.ts';
import type { RandomSource } from './credentials.ts';
import type { ClientRecord } from './repositories/clients.ts';
import type { ConnectedClient } from './repositories/consents.ts';
import type { TokenVerifier } from './verified-token.ts';
import type { DatabaseSync } from 'node:sqlite';

type AuthorizationServerConfig = Pick<
  Config,
  'publicUrl' | 'enableWriteScope' | 'oauthClients' | 'accessTokenTtlMs' | 'refreshTokenTtlMs'
>;

export interface AuthorizationServerDependencies {
  readonly config: AuthorizationServerConfig;
  readonly db: DatabaseSync;
  /**
  The identity module's ID-18 guards and proxy-aware client address.
  */
  readonly guards: Guards;
  readonly audit: OAuthAuditSink;
  readonly logger: WarnLogger;
  readonly fetch: FetchLike;
  readonly lookup: Lookup;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
}

export interface AuthorizationServer {
  readonly routes: OAuthRoutes;
  readonly tokenVerifier: TokenVerifier;
  /**
  OAUTH-30, for the account page.
  */
  readonly revokeConsent: (operatorId: string, consentId: string) => number | undefined;
  readonly listConnectedClients: (operatorId: string) => readonly ConnectedClient[];
  readonly renderConnectedClients: (session: SessionState) => Html;
}

/**
 * Spec §10.4.
 */
const LIMITS = {
  token: { limit: 60, windowMs: MINUTE_MS },
  register: { limit: 10, windowMs: HOUR_MS },
  authorize: { limit: 30, windowMs: MINUTE_MS },
  cimd: { limit: 30, windowMs: MINUTE_MS },
} as const;

function buildResolver(
  dependencies: AuthorizationServerDependencies,
  repos: OAuthRepos,
  preregistered: readonly ClientRecord[],
): ClientResolver {
  const { now } = dependencies;
  const cimd = createCimdFetcher({
    fetch: dependencies.fetch,
    lookup: dependencies.lookup,
    now,
    cache: repos.cimdCache,
    logger: dependencies.logger,
    rateLimiter: createRateLimiter({ ...LIMITS.cimd, now }),
  });
  return createClientResolver({
    preregistered,
    cimd,
    clients: repos.clients,
    now,
    newId: dependencies.newId,
  });
}

/**
 * Wires the authorization server over an open database. Fails only when the
 * pre-registered client list is invalid (OAUTH-12).
 */
export function createAuthorizationServer(
  dependencies: AuthorizationServerDependencies,
): Result<AuthorizationServer, PreregisteredClientsError> {
  const { config, now, guards } = dependencies;
  const preregistered = validatePreregisteredClients(config.oauthClients, {
    now: now(),
    newId: dependencies.newId,
  });
  if (!preregistered.ok) {
    return fail(preregistered.error);
  }
  const repos = createOAuthRepos(dependencies.db);
  for (const client of preregistered.value) {
    repos.clients.upsert(client);
  }
  const shared = {
    ...config,
    repos,
    guards,
    audit: dependencies.audit,
    now,
    random: dependencies.random,
    newId: dependencies.newId,
    clientIp: clientIpResolver(guards),
  };
  const authorize = {
    ...shared,
    resolver: buildResolver(dependencies, repos, preregistered.value),
    rateLimiter: createRateLimiter({ ...LIMITS.authorize, now }),
  };
  const routes = createOAuthRoutes({
    metadata: config,
    register: createRegisterHandler({
      ...shared,
      clients: repos.clients,
      rateLimiter: createRateLimiter({ ...LIMITS.register, now }),
    }),
    token: createTokenHandler({
      ...shared,
      rateLimiter: createRateLimiter({ ...LIMITS.token, now }),
    }),
    revoke: createRevokeHandler(shared),
    authorize: createAuthorizeHandler(authorize),
    consentPage: createConsentPageHandler(authorize),
    consentDecision: createConsentDecisionHandler(authorize),
    consentRevoke: createConsentRevokeHandler(shared),
  });
  return ok({
    routes,
    tokenVerifier: new StoreTokenVerifier({ publicUrl: config.publicUrl, repos, now }),
    revokeConsent: (operatorId, consentId) => revokeConsent(shared, operatorId, consentId),
    listConnectedClients: (operatorId) => listConnectedClients(shared, operatorId),
    renderConnectedClients: (session) =>
      renderConnectedClients(listConnectedClients(shared, session.operatorId), session),
  });
}
