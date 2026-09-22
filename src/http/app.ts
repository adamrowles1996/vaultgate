import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import type { Logger } from '../logger.ts';

interface AppEnvironment {
  readonly Variables: RequestIdVariables;
}

export type App = Hono<AppEnvironment>;

export interface AppDependencies {
  readonly logger: Logger;
}

/**
 * Builds the HTTP application. Only liveness and readiness probes exist at
 * this stage; the OAuth authorization server, the consent UI and the MCP
 * endpoint mount here in later milestones (see docs/PLAN.md).
 */
export function createApp({ logger }: AppDependencies): App {
  const app = new Hono<AppEnvironment>();

  app.use(requestId());
  app.use(secureHeaders());

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.get('/readyz', (context) => context.json({ status: 'ok' }));

  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((error, context) => {
    logger.error({ err: error, requestId: context.get('requestId') }, 'unhandled request error');
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}
