import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import { createMetadataApp } from '../mcp/metadata.ts';
import { createMcpRoutes } from '../mcp/routes.ts';

import type { ActionsEngine } from '../actions/engine.ts';
import type { AuditSink } from '../audit/event.ts';
import type { TokenVerifier } from '../auth/token-types.ts';
import type { Config } from '../config/index.ts';
import type { Identity, IdentityVariables } from '../identity/index.ts';
import type { Logger } from '../logger.ts';
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
 * `vault` carries the detail a signed-in operator may poll for (OPS-4).
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
  /**
  The authorization server's routes (spec §03), mounted at the root when supplied.
  */
  readonly oauth?: Hono<AppEnvironment> | undefined;
  /**
  The actions engine (spec §13), present only when the layer is enabled (ACT-73).
  */
  readonly engine?: ActionsEngine | undefined;
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
  // HSTS per ID-20, only over https.
  app.use(
    secureHeaders({
      strictTransportSecurity: identity.cookiePolicy.isSecure && STRICT_TRANSPORT_SECURITY,
    }),
  );

  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  // The session middleware comes before every route that can see the operator:
  // /readyz (vault detail is for a signed-in operator only, OPS-4), the
  // operator pages (spec §04), consent and /mcp.
  app.use(identity.attachSession);
  app.get('/readyz', (context) => {
    const { ready, failing, vault } = readiness();
    const detail = context.get('session') === undefined ? {} : { vault };
    return ready
      ? context.json({ status: 'ok', ...detail })
      : context.json({ status: 'unavailable', failing: [...failing], ...detail }, 503);
  });
  app.route('/', identity.routes);

  // The MCP resource server (spec §06): protected resource metadata and /mcp.
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
      engine: dependencies.engine,
    }),
  );

  if (dependencies.oauth !== undefined) {
    app.route('/', dependencies.oauth);
  }

  // 404: JSON for API clients, a page under ID-19 for a browser (ID-24).
  app.notFound(identity.notFound);
  app.onError((error, context) => {
    logger.error({ err: error, requestId: context.get('requestId') }, 'unhandled request error');
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}
