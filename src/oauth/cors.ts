import { cors } from 'hono/cors';

import type { MiddlewareHandler } from 'hono';

/**
 * OAUTH-37: the browser-reachable, cookie-free endpoints answer preflight
 * and are readable from any origin. Cookie-bearing routes never use this.
 * The header set is the one `src/mcp/metadata.ts` serves; the layering rules
 * keep this module from importing it, and the route tests hold both in step.
 */
export function publicCors(): MiddlewareHandler {
  return cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'Mcp-Method',
      'Mcp-Name',
    ],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  });
}
