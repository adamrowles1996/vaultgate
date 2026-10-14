/**
 * The relay's HTTP surface (RELAY-2, RELAY-3, RELAY-5): its own Hono app on
 * its own listener, sharing nothing with the OAuth, MCP and console routes.
 * Every request is admitted before any route runs: no browser origin, the
 * listen address as its `Host`, a tailnet peer the local Tailscale daemon
 * names, a tag the operator listed, and the node's rate limit. Whatever
 * fails is refused before the vault is touched, and audited.
 */
import { Hono, type Context } from 'hono';

import { createRateLimiter, type RateLimiter } from '../net/rate-limit.ts';

import {
  type Caller,
  handleItem,
  handleList,
  handleScalar,
  handleStatus,
  handleSync,
  type HandlerDependencies,
} from './handlers.ts';
import { SCALAR_KINDS, type ScalarKind } from './item-body.ts';
import { failure, FORBIDDEN, type RelayReply, UNKNOWN_ROUTE } from './responses.ts';
import { isAdmitted, type WhoIs } from './whois.ts';

import type { RelayListen } from '../config/relay.ts';
import type { Logger } from '../logger.ts';

export interface RelayAppDependencies extends HandlerDependencies {
  readonly listen: RelayListen;
  readonly tags: readonly string[];
  readonly whoIs: WhoIs;
  /**
  The socket's remote address; never a header (RELAY-3).
  */
  readonly peerAddress: (context: Context) => string | undefined;
  readonly logger: Logger;
  readonly now: () => number;
}

interface RelayEnvironment {
  readonly Variables: { caller: Caller };
}

export type RelayApp = Hono<RelayEnvironment>;

/**
RELAY-9: requests per minute one node may make.
*/
export const RATE_LIMIT_PER_MINUTE = 300;
const MINUTE_MS = 60_000;
const IPV4_MAPPED = /^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i;
const HTTP_DEFAULT_PORT = 80;

/**
The `Host` values that name the listener: the address and port, or the bare address on port 80.
*/
function expectedHosts(listen: RelayListen): ReadonlySet<string> {
  const host = listen.host.includes(':') ? `[${listen.host.toLowerCase()}]` : listen.host;
  const hosts = new Set([`${host}:${String(listen.port)}`]);
  if (listen.port === HTTP_DEFAULT_PORT) {
    hosts.add(host);
  }
  return hosts;
}

function send(context: Context, reply: RelayReply, retryAfterSeconds?: number): Response {
  if (retryAfterSeconds !== undefined) {
    context.header('retry-after', String(retryAfterSeconds));
  }
  return context.json(reply.body, reply.status);
}

interface Refusal {
  readonly reason: string;
  readonly ip?: string | undefined;
  readonly node?: string;
  readonly reply?: RelayReply;
  readonly retryAfterSeconds?: number;
}

/**
The caller, or why it is refused; checks run cheapest first and stop at the first failure.
*/
async function admit(
  dependencies: RelayAppDependencies,
  hosts: ReadonlySet<string>,
  limiter: RateLimiter,
  context: Context,
): Promise<Caller | Refusal> {
  const address = dependencies.peerAddress(context)?.replace(IPV4_MAPPED, '');
  if (context.req.header('origin') !== undefined) {
    return { reason: 'origin', ip: address };
  }
  if (!hosts.has((context.req.header('host') ?? '').toLowerCase())) {
    return { reason: 'host', ip: address };
  }
  if (address === undefined) {
    return { reason: 'no_address' };
  }
  const peer = await dependencies.whoIs(address);
  if (peer === undefined) {
    return { reason: 'not_a_peer', ip: address };
  }
  if (!isAdmitted(peer, dependencies.tags)) {
    return { reason: 'untagged', ip: address, node: peer.node };
  }
  const decision = limiter.take(peer.node);
  if (!decision.allowed) {
    return {
      reason: 'rate_limited',
      ip: address,
      node: peer.node,
      reply: failure(429, 'Too many requests.'),
      retryAfterSeconds: decision.retryAfterSeconds,
    };
  }
  return { node: peer.node, ip: address };
}

function isScalarKind(kind: string): kind is ScalarKind {
  return (SCALAR_KINDS as readonly string[]).includes(kind);
}

export function createRelayApp(dependencies: RelayAppDependencies): RelayApp {
  const app = new Hono<RelayEnvironment>();
  const hosts = expectedHosts(dependencies.listen);
  const limiter = createRateLimiter({
    limit: RATE_LIMIT_PER_MINUTE,
    windowMs: MINUTE_MS,
    now: dependencies.now,
  });

  app.use(async (context, next) => {
    const admitted = await admit(dependencies, hosts, limiter, context);
    if ('reason' in admitted) {
      dependencies.audit.record({
        category: 'relay',
        action: 'relay.denied',
        outcome: 'denied',
        ip: admitted.ip,
        details: {
          reason: admitted.reason,
          ...(admitted.node !== undefined && { node: admitted.node }),
        },
      });
      dependencies.logger.warn({ reason: admitted.reason, ip: admitted.ip }, 'relay refused');
      return send(context, admitted.reply ?? FORBIDDEN, admitted.retryAfterSeconds);
    }
    context.set('caller', admitted);
    await next();
    return;
  });

  app.get('/status', async (context) =>
    send(context, await handleStatus(dependencies, context.var.caller)),
  );
  app.post('/sync', (context) => send(context, handleSync(dependencies, context.var.caller)));
  app.get('/list/object/items', async (context) =>
    send(context, await handleList(dependencies, context.var.caller, context.req.query('search'))),
  );
  app.get('/object/item/:id', async (context) =>
    send(context, await handleItem(dependencies, context.var.caller, context.req.param('id'))),
  );
  app.get('/object/:kind/:id', async (context) => {
    const kind = context.req.param('kind');
    if (!isScalarKind(kind)) {
      return send(context, UNKNOWN_ROUTE);
    }
    const term = context.req.param('id');
    return send(context, await handleScalar(dependencies, context.var.caller, kind, term));
  });
  app.notFound((context) => send(context, UNKNOWN_ROUTE));
  app.onError((error, context) => {
    dependencies.logger.error({ err: error }, 'relay request failed');
    return send(context, failure(500, 'Relay error.'));
  });
  return app;
}
