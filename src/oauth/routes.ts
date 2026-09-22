import { Hono } from 'hono';

import { publicCors } from './cors.ts';
import {
  authorizationServerMetadata,
  AUTHORIZE_PATH,
  METADATA_HEADERS,
  METADATA_PATH,
  type MetadataConfig,
  REGISTER_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
} from './metadata.ts';

import type { Context } from 'hono';

export type RouteHandler = (context: Context) => Promise<Response>;

export interface OAuthRouteHandlers {
  readonly metadata: MetadataConfig;
  readonly register: RouteHandler;
  readonly token: RouteHandler;
  readonly revoke: RouteHandler;
  readonly authorize: RouteHandler;
  readonly consentPage: RouteHandler;
  readonly consentDecision: RouteHandler;
}

/**
 * §3.1 URL table. Cookie-bearing routes (`/oauth/authorize*`) never set CORS
 * headers (OAUTH-37).
 */
export function createOAuthRoutes(handlers: OAuthRouteHandlers): Hono {
  const app = new Hono();
  const document = JSON.stringify(authorizationServerMetadata(handlers.metadata));

  app.use(METADATA_PATH, publicCors());
  app.get(METADATA_PATH, (context) => context.body(document, 200, METADATA_HEADERS));

  for (const path of [TOKEN_PATH, REVOKE_PATH, REGISTER_PATH]) {
    app.use(path, publicCors());
  }
  app.post(TOKEN_PATH, (context) => handlers.token(context));
  app.post(REVOKE_PATH, (context) => handlers.revoke(context));
  app.post(REGISTER_PATH, (context) => handlers.register(context));

  app.get(AUTHORIZE_PATH, (context) => handlers.authorize(context));
  app.post(AUTHORIZE_PATH, (context) => handlers.consentDecision(context));
  app.get(`${AUTHORIZE_PATH}/:id`, (context) => handlers.consentPage(context));

  return app;
}
