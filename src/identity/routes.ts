import { Hono } from 'hono';

import { type IdentityEnvironment, pageHeaders } from './browser.ts';
import { STYLESHEET } from './pages/stylesheet.ts';
import { registerAccountRoutes } from './routes-account.ts';
import { registerAuditRoutes } from './routes-audit.ts';
import { registerConsoleRoutes } from './routes-console.ts';
import { registerEmailRoutes } from './routes-email.ts';
import { registerLoginRoutes } from './routes-login.ts';
import { registerSetupRoutes } from './routes-setup.ts';
import { registerVaultRoutes } from './routes-vault.ts';

import type { IdentityServices } from './services.ts';

const STYLESHEET_MAX_AGE_SECONDS = 3600;

/**
 * The browser-facing routes: the site root, `/setup`, `/login`, `/logout`,
 * `/account` and the stylesheet. Mounted at the root by the HTTP application;
 * the session middleware runs before them.
 */
export function createIdentityRoutes(services: IdentityServices): Hono<IdentityEnvironment> {
  const app = new Hono<IdentityEnvironment>();
  app.use('/', pageHeaders);
  app.use('/setup', pageHeaders);
  app.use('/login/*', pageHeaders);
  app.use('/login', pageHeaders);
  app.use('/logout', pageHeaders);
  app.use('/account/*', pageHeaders);
  app.use('/account', pageHeaders);

  // -- ID-23: the bare address goes to the console's home or, without a session, to login --
  app.get('/', (context) =>
    context.redirect(context.get('session') === undefined ? '/login' : services.homePath, 303),
  );

  app.get('/static/vaultgate.css', (context) =>
    context.text(STYLESHEET, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': `public, max-age=${STYLESHEET_MAX_AGE_SECONDS}`,
    }),
  );

  registerSetupRoutes(app, services);
  registerLoginRoutes(app, services);
  registerAccountRoutes(app, services);
  registerConsoleRoutes(app, services);
  registerAuditRoutes(app, services);
  registerEmailRoutes(app, services);
  registerVaultRoutes(app, services);
  return app;
}
