import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import { createMetadataApp } from '../mcp/metadata.ts';
import { createMcpRoutes } from '../mcp/routes.ts';

import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { AuditSink } from '../mcp/audit.ts';
import type { TokenVerifier } from '../mcp/token-verifier.ts';
import type { VaultClient } from '../vault/client.ts';

interface AppEnvironment {
  readonly Variables: RequestIdVariables;
}

export type App = Hono<AppEnvironment>;

/**
 * What `/readyz` reports (spec §10.2): `failing` names each component that is
 * not ready, so an operator can tell a locked vault from a broken store.
 */
export interface Readiness {
  readonly ready: boolean;
  readonly failing: readonly string[];
}

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly readiness: () => Readiness;
  readonly vaultClient: VaultClient;
  readonly tokenVerifier: TokenVerifier;
  readonly auditSink: AuditSink;
  /**
  Injected clock for rate limits and audit timestamps; defaults to the wall clock.
  */
  readonly now?: () => number;
}

/**
 * Builds the HTTP application: probes, the protected resource metadata and
 * the MCP endpoint. The OAuth authorization server and the consent UI mount
 * here in later milestones (see docs/PLAN.md).
 */
export function createApp(dependencies: AppDependencies): App {
  const { config, logger, readiness } = dependencies;
  const app = new Hono<AppEnvironment>();

  app.use(requestId());
  app.use(secureHeaders());

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  // -- storage: readiness reflects the store; later milestones add bw serve --
  app.get('/readyz', (context) => {
    const { ready, failing } = readiness();
    return ready
      ? context.json({ status: 'ok' })
      : context.json({ status: 'unavailable', failing: [...failing] }, 503);
  });
  // -- end storage --

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

  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((error, context) => {
    logger.error({ err: error, requestId: context.get('requestId') }, 'unhandled request error');
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}
