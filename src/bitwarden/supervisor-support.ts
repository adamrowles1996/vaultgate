/**
 * What the supervisor is given and what it falls back to, kept apart from the
 * lifecycle so the state machine in `supervisor.ts` stays readable.
 */
import { systemClock } from './clock.ts';
import { allocateLoopbackPort } from './ports.ts';
import { spawnChild } from './serve-process.ts';

import type { FetchFunction } from './api.ts';
import type { Clock } from './clock.ts';
import type { SpawnFunction } from './serve-process.ts';
import type { Environment } from '../config/index.ts';
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
