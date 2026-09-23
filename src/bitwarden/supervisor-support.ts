/**
 * What the supervisor is given and what it falls back to, kept apart from the
 * lifecycle so the state machine in `supervisor.ts` stays readable.
 */
import { ok, type Result } from '../result.ts';

import { systemClock } from './clock.ts';
import { allocateLoopbackPort } from './ports.ts';
import { spawnChild } from './serve-process.ts';

import type { FetchFunction } from './api.ts';
import type { Clock } from './clock.ts';
import type { Credentials } from './credentials.ts';
import type { BwCli, SpawnFunction } from './serve-process.ts';
import type { Environment } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultError } from '../vault/client.ts';

export interface VaultSupervisorDependencies {
  /**
  The parent environment; only `PATH`, `HOME` and `TMPDIR` reach the CLI.
  */
  readonly environment: Environment;
  readonly spawn?: SpawnFunction;
  readonly clock?: Clock;
  readonly fetch?: FetchFunction;
  readonly allocatePort?: () => Promise<number>;
}

interface ResolvedDependencies {
  readonly environment: Environment;
  readonly spawn: SpawnFunction;
  readonly clock: Clock;
  readonly fetch: FetchFunction;
  readonly allocatePort: () => Promise<number>;
}

/**
Fills in the real process, clock, network and port allocation where a test injected nothing.
*/
export function resolveDependencies(
  dependencies: VaultSupervisorDependencies,
): ResolvedDependencies {
  return {
    environment: dependencies.environment,
    spawn: dependencies.spawn ?? spawnChild,
    clock: dependencies.clock ?? systemClock,
    fetch: dependencies.fetch ?? fetch,
    allocatePort: dependencies.allocatePort ?? allocateLoopbackPort,
  };
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * How long `bw serve` must stay ready before its next exit starts the failure
 * count afresh (VAULT-6). A child that dies sooner, however it got there, is
 * one more consecutive failure, so a crash loop after a successful unlock
 * reaches the backoff and the error-level escalation like any other.
 */
export const MIN_HEALTHY_UPTIME_MS = 5 * 60_000;

export function backoffMs(consecutiveFailures: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(consecutiveFailures - 1, 0), MAX_BACKOFF_MS);
}

/**
How long after spawning `bw serve` an `/unlock` protocol error is treated as "not ready yet" (VAULT-6).
*/
export const SERVE_SETTLE_MS = 10_000;
export const SERVE_SETTLE_POLL_MS = 250;

/**
 * A fresh `bw serve` accepts connections a moment before its command
 * handlers are, and in that moment `/unlock` can answer with something other
 * than the JSON envelope (seen once per cold start right after
 * `bw login --apikey`). Inside the settle window that is retried rather than
 * counted as a failed start; after it, a protocol error is what it says.
 */
export function isServeSettling(error: VaultError, spawnedAt: number, now: number): boolean {
  return error.code === 'vault_protocol_error' && now - spawnedAt < SERVE_SETTLE_MS;
}

/**
Logs in when the CLI reports `unauthenticated`, configuring the server first (VAULT-3, 4).
*/
export async function ensureLoggedIn(
  cli: BwCli,
  server: string | undefined,
  credentials: Credentials,
  logger: Logger,
): Promise<Result<void>> {
  const status = await cli.status();
  if (!status.ok) {
    return status;
  }
  if (status.value.status !== 'unauthenticated') {
    return ok(undefined);
  }
  if (server !== undefined) {
    const configured = await cli.configureServer(server);
    if (!configured.ok) {
      return configured;
    }
  }
  logger.info('logging in to bitwarden with the api key');
  return cli.login(credentials);
}
