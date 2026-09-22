import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import type { Logger } from '../logger.ts';

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
  readonly logger: Logger;
  readonly readiness: () => Readiness;
}

/**
 * Builds the HTTP application. Only liveness and readiness probes exist at
 * this stage; the OAuth authorization server, the consent UI and the MCP
 * endpoint mount here in later milestones (see docs/PLAN.md).
 */
export function createApp({ logger, readiness }: AppDependencies): App {
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

  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((error, context) => {
    logger.error({ err: error, requestId: context.get('requestId') }, 'unhandled request error');
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}
