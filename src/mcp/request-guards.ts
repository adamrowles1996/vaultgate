/**
 * Pre-authentication checks on `/mcp` requests: DNS-rebinding defence (MCP-3),
 * the query-string token rule (OAUTH-31) and source-address resolution (OPS-6).
 */
import { z } from 'zod';

import type { Config } from '../config/index.ts';

export type GuardConfig = Pick<Config, 'publicUrl' | 'allowedOrigins' | 'trustProxy'>;

export type GuardVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function firstForwarded(value: string | null): string | undefined {
  const first = value?.split(',', 1)[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}

/**
MCP-3: a present `Origin` must be the public origin or an allowed extra origin.
*/
export function checkOrigin(headers: Headers, config: GuardConfig): GuardVerdict {
  const origin = headers.get('origin');
  if (origin === null) {
    return { ok: true };
  }
  const allowed = [new URL(config.publicUrl).origin, ...config.allowedOrigins];
  return allowed.includes(origin) ? { ok: true } : { ok: false, reason: 'origin not allowed' };
}

/**
MCP-3: `Host` (or, behind a trusted proxy, `X-Forwarded-Host`) must be the public host.
*/
export function checkHost(request: Request, config: GuardConfig): GuardVerdict {
  const forwarded = config.trustProxy
    ? firstForwarded(request.headers.get('x-forwarded-host'))
    : undefined;
  const host = forwarded ?? request.headers.get('host') ?? new URL(request.url).host;
  return host.toLowerCase() === new URL(config.publicUrl).host
    ? { ok: true }
    : { ok: false, reason: 'host does not match the public URL' };
}

/**
OAUTH-31: a token in the query string is rejected outright.
*/
export function hasQueryStringToken(url: string): boolean {
  return new URL(url).searchParams.has('access_token');
}

const socketSchema = z.object({ remoteAddress: z.string() });
const incomingSchema = z.object({ socket: socketSchema });
const socketBindings = z.object({ incoming: incomingSchema });

/**
OPS-6: the socket address, or the first forwarded address only behind a trusted proxy.
*/
export function resolveSourceIp(request: Request, bindings: unknown, config: GuardConfig): string {
  const forwarded = config.trustProxy
    ? firstForwarded(request.headers.get('x-forwarded-for'))
    : undefined;
  if (forwarded !== undefined) {
    return forwarded;
  }
  const parsed = socketBindings.safeParse(bindings);
  return parsed.success ? parsed.data.incoming.socket.remoteAddress : 'unknown';
}
