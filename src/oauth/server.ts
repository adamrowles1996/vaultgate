import { fail, ok, type Result } from '../result.ts';

import { createAuthorizeHandler, createConsentPageHandler } from './authorize.ts';
import { createClientIpResolver } from './client-ip.ts';
import { createCimdFetcher, type WarnLogger } from './clients/cimd.ts';
import {
  type PreregisteredClientsError,
  validatePreregisteredClients,
} from './clients/preregistered.ts';
import { type ClientResolver, createClientResolver } from './clients/resolve.ts';
import { type Clock, HOUR_MS, MINUTE_MS } from './clock.ts';
import { createConsentDecisionHandler } from './consent.ts';
import { createCsrfGuard } from './csrf.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createRegisterHandler } from './register.ts';
import { createOAuthRepos, type OAuthRepos } from './repositories/index.ts';
import { createRevokeHandler, listConnectedClients, revokeConsent } from './revoke.ts';
import { createOAuthRoutes } from './routes.ts';
import { StoreTokenVerifier } from './token-verifier.ts';
import { createTokenHandler } from './token.ts';

import type { AuditSink } from './audit.ts';
import type { FetchLike, Lookup } from './clients/ssrf-fetch.ts';
import type { RandomSource } from './credentials.ts';
import type { ClientRecord } from './repositories/clients.ts';
import type { ConnectedClient } from './repositories/consents.ts';
import type { CsrfGuard, OperatorSessionResolver } from './session.ts';
import type { TokenVerifier } from './verified-token.ts';
import type { Config } from '../config/index.ts';
import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

export type AuthorizationServerConfig = Pick<
  Config,
  | 'publicUrl'
  | 'enableWriteScope'
  | 'oauthClients'
  | 'accessTokenTtlMs'
  | 'refreshTokenTtlMs'
  | 'trustProxy'
>;

export interface AuthorizationServerDependencies {
  readonly config: AuthorizationServerConfig;
  readonly db: DatabaseSync;
  readonly sessions: OperatorSessionResolver;
  /**
  Defaults to the ID-18 guard in `csrf.ts`; the identity module may supply its own.
  */
  readonly csrf?: CsrfGuard | undefined;
  readonly audit: AuditSink;
  readonly logger: WarnLogger;
  readonly fetch: FetchLike;
  readonly lookup: Lookup;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  readonly socketAddress: (request: Request) => string | undefined;
  readonly loginPath?: string | undefined;
}

export interface AuthorizationServer {
  readonly routes: Hono;
  readonly tokenVerifier: TokenVerifier;
  /**
  OAUTH-30, for the account page.
  */
  readonly revokeConsent: (operatorId: string, consentId: string) => number | undefined;
  readonly listConnectedClients: (operatorId: string) => readonly ConnectedClient[];
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
  const { config, now } = dependencies;
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
  const clientIp = createClientIpResolver({
    trustProxy: config.trustProxy,
    socketAddress: dependencies.socketAddress,
  });
  const resolver = buildResolver(dependencies, repos, preregistered.value);
  const shared = {
    ...config,
    repos,
    audit: dependencies.audit,
    now,
    random: dependencies.random,
    newId: dependencies.newId,
    clientIp,
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
    ...consentHandlers({
      ...shared,
      resolver,
      sessions: dependencies.sessions,
      csrf: dependencies.csrf,
      loginPath: dependencies.loginPath,
    }),
  });
  return ok({
    routes,
    tokenVerifier: new StoreTokenVerifier({ publicUrl: config.publicUrl, repos, now }),
    revokeConsent: (operatorId, consentId) => revokeConsent(shared, operatorId, consentId),
    listConnectedClients: (operatorId) => listConnectedClients(shared, operatorId),
  });
}

type ConsentInput = Omit<
  Parameters<typeof createAuthorizeHandler>[0],
  'csrf' | 'rateLimiter' | 'loginPath'
> & {
  readonly csrf: CsrfGuard | undefined;
  readonly loginPath: string | undefined;
};

function consentHandlers(
  input: ConsentInput,
): Pick<Parameters<typeof createOAuthRoutes>[0], 'authorize' | 'consentPage' | 'consentDecision'> {
  const authorizeDependencies = {
    ...input,
    csrf: input.csrf ?? createCsrfGuard(input.publicUrl),
    rateLimiter: createRateLimiter({ ...LIMITS.authorize, now: input.now }),
    loginPath: input.loginPath ?? '/login',
  };
  return {
    authorize: createAuthorizeHandler(authorizeDependencies),
    consentPage: createConsentPageHandler(authorizeDependencies),
    consentDecision: createConsentDecisionHandler(authorizeDependencies),
  };
}
