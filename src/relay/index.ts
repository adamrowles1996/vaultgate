/**
 * The credential relay (spec §15, ADR 0009): a `bw serve`-compatible,
 * read-only HTTP endpoint for helpers on tagged tailnet nodes that need a
 * credential's value in process. Composition builds it only when a listen
 * address is configured (RELAY-1) and serves it on its own listener.
 */
import { createLocalHttp, type LocalRequestFunction } from '../net/local-http.ts';

import { createRelayApp, type RelayApp } from './app.ts';
import { createScope } from './scope.ts';
import { createWhoIs } from './whois.ts';

import type { AuditSink } from '../audit/event.ts';
import type { RelayConfig, RelayListen } from '../config/relay.ts';
import type { Logger } from '../logger.ts';
import type { VaultClient } from '../vault/client.ts';
import type { Context } from 'hono';

export type { RelayApp } from './app.ts';

export interface RelayOptions {
  readonly config: RelayConfig;
  readonly listen: RelayListen;
  readonly vault: VaultClient;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly now: () => number;
  readonly peerAddress: (context: Context) => string | undefined;
  /**
  `http.request` for the LocalAPI socket; replaceable for tests.
  */
  readonly request?: LocalRequestFunction;
}

export function createRelay(options: RelayOptions): RelayApp {
  const localApi = createLocalHttp(`unix:${options.config.tailscaleSocket}`, options.request);
  return createRelayApp({
    listen: options.listen,
    tags: options.config.tags,
    scope: createScope(options.config.collections, options.config.items),
    whoIs: createWhoIs(localApi),
    vault: options.vault,
    audit: options.audit,
    logger: options.logger,
    now: options.now,
    peerAddress: options.peerAddress,
  });
}
