import { type Bootstrap, createBootstrap } from './bootstrap.ts';
import { attachSession } from './browser.ts';
import { createGuards, type Guards } from './guards.ts';
import { createLoginThrottle } from './login-throttle.ts';
import { EMPTY } from './pages/template.ts';
import { createLocalProvider, type IdentityProvider } from './provider.ts';
import { createIdentityStores } from './repositories/index.ts';
import { createIdentityRoutes } from './routes.ts';
import { createSecretBox, STATE_COOKIE_INFO, TOTP_SECRET_INFO } from './secret-box.ts';
import { createSessionManager } from './session-manager.ts';
import { cookiePolicyFor, type CookiePolicy } from './sessions.ts';
import { createStateCodec } from './state-cookie.ts';

import type { ClientAddressResolver, IdentityEnvironment } from './context.ts';
import type { ScryptParameters } from './password.ts';
import type { Clock, Delay, RandomSource } from './primitives.ts';
import type { AuditSink } from '../audit/event.ts';
import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { ConnectedClientsRenderer, IdentityServices } from './services.ts';
import type { Hono, MiddlewareHandler } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

export type { IdentityVariables } from './context.ts';
export type { ConnectedClientsRenderer } from './services.ts';
export { CURRENT_PARAMETERS } from './password.ts';
type IdentityConfig = Pick<Config, 'publicUrl' | 'trustProxy' | 'sessionTtlMs' | 'secrets'>;

export interface IdentityDependencies {
  readonly config: IdentityConfig;
  readonly database: DatabaseSync;
  readonly logger: Logger;
  readonly audit: AuditSink;
  readonly random: RandomSource;
  readonly clock: Clock;
  readonly delay: Delay;
  readonly clientAddress: ClientAddressResolver;
  readonly passwordParameters: ScryptParameters;
  /**
  The account page's connected-clients section; empty until the OAuth layer supplies it.
  */
  readonly connectedClients?: ConnectedClientsRenderer | undefined;
}

export interface Identity {
  readonly routes: Hono<IdentityEnvironment>;
  /**
  Resolves the session cookie into `context.var.session`; install before any browser route.
  */
  readonly attachSession: MiddlewareHandler<IdentityEnvironment>;
  readonly provider: IdentityProvider;
  readonly bootstrap: Bootstrap;
  readonly cookiePolicy: CookiePolicy;
  /**
  Origin and synchroniser-token checks for state-changing browser routes outside this module.
  */
  readonly guards: Guards;
}

/**
 * Wires spec 04 together over an open, migrated database. Entropy, the
 * clock, the backoff sleep and the socket-address lookup are injected so the
 * whole module is testable in-process (ADR 0006).
 */
export function createIdentity(dependencies: IdentityDependencies): Identity {
  const { config, database, logger, audit, random, clock, delay, clientAddress } = dependencies;
  const cookiePolicy = cookiePolicyFor(config.publicUrl);
  if (!cookiePolicy.isSecure) {
    logger.warn(
      'VAULTGATE_PUBLIC_URL is plain http: session cookies are sent without Secure or the __Host- prefix (development only)',
    );
  }
  const stores = createIdentityStores(database);
  const guards = createGuards({
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    clientAddress,
    audit,
  });
  const bootstrap = createBootstrap({
    operators: stores.operators,
    bootstrapTokens: stores.bootstrapTokens,
    publicUrl: config.publicUrl,
    presetToken: config.secrets.bootstrapToken,
    logger,
    random,
    clock,
  });
  const services: IdentityServices = {
    database,
    stores,
    bootstrap,
    sessions: createSessionManager({
      sessions: stores.sessions,
      random,
      clock,
      absoluteTtlMs: config.sessionTtlMs,
    }),
    throttle: createLoginThrottle(stores.loginAttempts, clock),
    guards,
    stateCodec: createStateCodec(
      createSecretBox(config.secrets.secretKey, STATE_COOKIE_INFO, random),
    ),
    totpBox: createSecretBox(config.secrets.secretKey, TOTP_SECRET_INFO, random),
    cookiePolicy,
    audit,
    random,
    clock,
    delay,
    passwordParameters: dependencies.passwordParameters,
    absoluteSessionTtlMs: config.sessionTtlMs,
    connectedClients: dependencies.connectedClients ?? (() => EMPTY),
  };
  return {
    routes: createIdentityRoutes(services),
    attachSession: attachSession(services),
    provider: createLocalProvider(),
    bootstrap,
    cookiePolicy,
    guards,
  };
}
