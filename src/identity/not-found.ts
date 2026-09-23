import { accepts } from 'hono/accepts';

import { CONTENT_SECURITY_POLICY } from './browser.ts';
import { renderNotFound } from './pages/not-found.ts';

import type { IdentityEnvironment } from './context.ts';
import type { NotFoundHandler } from 'hono';

const HTML = 'text/html';
const JSON_TYPE = 'application/json';

/**
 * The application's 404 (ID-24): the JSON body for API clients (no `Accept`,
 * or one that does not prefer HTML) and a page under the ID-19 policy for a
 * browser. Installed by the HTTP application as its fallback.
 */
export const notFound: NotFoundHandler<IdentityEnvironment> = (context) => {
  const preferred = accepts(context, {
    header: 'Accept',
    supports: [JSON_TYPE, HTML],
    default: JSON_TYPE,
  });
  if (preferred !== HTML) {
    return context.json({ error: 'not_found' }, 404);
  }
  return context.html(renderNotFound(), 404, {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Cache-Control': 'no-store',
  });
};
