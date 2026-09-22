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
