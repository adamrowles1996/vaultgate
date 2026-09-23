import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import { createMetadataApp } from '../mcp/metadata.ts';
import { createMcpRoutes } from '../mcp/routes.ts';

import type { AuditSink } from '../audit/event.ts'; // -- audit --
import type { Config } from '../config/index.ts';
import type { Identity, IdentityVariables } from '../identity/index.ts';
import type { Logger } from '../logger.ts';
import type { TokenVerifier } from '../mcp/token-verifier.ts';
import type { VaultClient } from '../vault/client.ts';

interface AppEnvironment {
  readonly Variables: RequestIdVariables & IdentityVariables;
}

/**
ID-20, verbatim; only sent when the public URL is https.
*/
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

export type App = Hono<AppEnvironment>;

/**
The vault's detail on `/readyz`: whether it serves, whether it has credentials at all (VAULT-18) and when it last synced (VAULT-9).
*/
interface VaultReadiness {
  readonly ready: boolean;
  readonly configured: boolean;
  readonly lastSyncAt: string | null;
}

/**
 * What `/readyz` reports (spec §10.2): `failing` names each component that is
 * not ready, so an operator can tell a locked vault from a broken store, and
 * `vault` carries the one detail worth polling, the time of the last sync.
 */
export interface Readiness {
  readonly ready: boolean;
  readonly failing: readonly string[];
  readonly vault: VaultReadiness;
}

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly readiness: () => Readiness;
  readonly identity: Identity;
  readonly vaultClient: VaultClient;
  readonly tokenVerifier: TokenVerifier;
  readonly auditSink: AuditSink;
  /**
  Injected clock for rate limits and audit timestamps; defaults to the wall clock.
  */
  readonly now?: () => number;
  // -- oauth: the authorization server's routes (spec §03), mounted at the root
  readonly oauth?: Hono<AppEnvironment> | undefined;
  // -- end oauth ------------------------------------------------------------
}

/**
 * Builds the HTTP application: probes, the protected resource metadata and
 * the MCP endpoint, the operator pages and, when supplied, the OAuth
 * authorization server.
 */
export function createApp(dependencies: AppDependencies): App {
  const { config, logger, readiness, identity } = dependencies;
  const app = new Hono<AppEnvironment>();

  app.use(requestId());
  // -- identity: HSTS per ID-20 --
  app.use(
    secureHeaders({
      strictTransportSecurity: identity.cookiePolicy.isSecure && STRICT_TRANSPORT_SECURITY,
    }),
  );
  // -- end identity --

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  // -- storage: readiness reflects the store; later milestones add bw serve --
  app.get('/readyz', (context) => {
    const { ready, failing, vault } = readiness();
    return ready
      ? context.json({ status: 'ok', vault })
      : context.json({ status: 'unavailable', failing: [...failing], vault }, 503);
  });
  // -- end storage --

  // -- identity: operator session, setup, login and account pages (spec §04) --
  app.use(identity.attachSession);
  app.route('/', identity.routes);
  // -- end identity --

  // -- MCP resource server (spec §06) ------------------------------------
  app.route('/', createMetadataApp(config));
  app.route(
    '/',
    createMcpRoutes({
      config,
      logger,
      vaultClient: dependencies.vaultClient,
      tokenVerifier: dependencies.tokenVerifier,
      auditSink: dependencies.auditSink,
      now: dependencies.now ?? Date.now,
    }),
  );
  // -- end MCP resource server --------------------------------------------

  // -- oauth: after the session middleware, so consent sees the operator ----
  if (dependencies.oauth !== undefined) {
    app.route('/', dependencies.oauth);
  }
  // -- end oauth ------------------------------------------------------------

  // -- identity: JSON for API clients, a page under ID-19 for a browser (ID-24) --
  app.notFound(identity.notFound);
  // -- end identity --
  app.onError((error, context) => {
    logger.error({ err: error, requestId: context.get('requestId') }, 'unhandled request error');
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}
