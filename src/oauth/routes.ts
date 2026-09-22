import { Hono } from 'hono';

import { pageHeaders } from '../identity/browser.ts';

import { CONSENT_REVOKE_PATH } from './connected-clients.ts';
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

import type { OAuthHandler } from './request-context.ts';
import type { IdentityEnvironment } from '../identity/context.ts';

export interface OAuthRouteHandlers {
  readonly metadata: MetadataConfig;
  readonly register: OAuthHandler;
  readonly token: OAuthHandler;
  readonly revoke: OAuthHandler;
  readonly authorize: OAuthHandler;
  readonly consentPage: OAuthHandler;
  readonly consentDecision: OAuthHandler;
  readonly consentRevoke: OAuthHandler;
}

export type OAuthRoutes = Hono<IdentityEnvironment>;

/**
 * §3.1 URL table. The browser routes carry the ID-19 page headers and never
 * CORS (OAUTH-37); the machine routes are CORS-open and cookie-free.
 */
export function createOAuthRoutes(handlers: OAuthRouteHandlers): OAuthRoutes {
  const app = new Hono<IdentityEnvironment>();
  const document = JSON.stringify(authorizationServerMetadata(handlers.metadata));

  app.use(METADATA_PATH, publicCors());
  app.get(METADATA_PATH, (context) => context.body(document, 200, METADATA_HEADERS));

  for (const path of [TOKEN_PATH, REVOKE_PATH, REGISTER_PATH]) {
    app.use(path, publicCors());
  }
  app.post(TOKEN_PATH, (context) => handlers.token(context));
  app.post(REVOKE_PATH, (context) => handlers.revoke(context));
  app.post(REGISTER_PATH, (context) => handlers.register(context));

  app.use(AUTHORIZE_PATH, pageHeaders);
  app.use(`${AUTHORIZE_PATH}/*`, pageHeaders);
  app.get(AUTHORIZE_PATH, (context) => handlers.authorize(context));
  app.post(AUTHORIZE_PATH, (context) => handlers.consentDecision(context));
  app.get(`${AUTHORIZE_PATH}/:id`, (context) => handlers.consentPage(context));
  app.post(CONSENT_REVOKE_PATH, (context) => handlers.consentRevoke(context));

  return app;
}
