import { Hono } from 'hono';

import { type IdentityEnvironment, pageHeaders } from './browser.ts';
import { STYLESHEET } from './pages/stylesheet.ts';
import { registerAccountRoutes } from './routes-account.ts';
import { registerAuditRoutes } from './routes-audit.ts';
import { registerLoginRoutes } from './routes-login.ts';
import { registerSetupRoutes } from './routes-setup.ts';

import type { IdentityServices } from './services.ts';

const STYLESHEET_MAX_AGE_SECONDS = 3600;

/**
 * The browser-facing routes: `/setup`, `/login`, `/logout`, `/account` and
 * the stylesheet. Mounted at the root by the HTTP application; the session
 * middleware runs before them.
 */
export function createIdentityRoutes(services: IdentityServices): Hono<IdentityEnvironment> {
  const app = new Hono<IdentityEnvironment>();
  app.use('/setup', pageHeaders);
  app.use('/login/*', pageHeaders);
  app.use('/login', pageHeaders);
  app.use('/logout', pageHeaders);
  app.use('/account/*', pageHeaders);
  app.use('/account', pageHeaders);

  app.get('/static/vaultgate.css', (context) =>
    context.text(STYLESHEET, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': `public, max-age=${STYLESHEET_MAX_AGE_SECONDS}`,
    }),
  );

  registerSetupRoutes(app, services);
  registerLoginRoutes(app, services);
  registerAccountRoutes(app, services);
  registerAuditRoutes(app, services);
  return app;
}
