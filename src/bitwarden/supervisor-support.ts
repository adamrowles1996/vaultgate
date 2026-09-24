/**
 * What the supervisor is given and what it falls back to, kept apart from the
 * lifecycle so the state machine in `supervisor.ts` stays readable.
 */
import { rm } from 'node:fs/promises';

import { ok, type Result } from '../result.ts';

import { systemClock } from './clock.ts';
import { allocateLoopbackPort } from './ports.ts';
import { spawnChild } from './serve-process.ts';

import type { FetchFunction } from './api.ts';
import type { Clock } from './clock.ts';
import type { Credentials } from './credentials.ts';
import type { BwCli, SpawnFunction } from './serve-process.ts';
import type { StoredVaultSettings } from './settings.ts';
import type { Environment } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultError } from '../vault/client.ts';

export type RemoveDirectory = (path: string) => Promise<void>;

/**
 * A lock on the way down (VAULT-7). A backend that has gone cannot be
 * locked and need not be, its session having died with it, so a clean stop
 * logs no warning; a reachable vault that refuses still does.
 */
export function recordLock(logger: Logger, locked: Result<unknown, VaultError>): void {
  if (locked.ok) {
    logger.info('vault locked');
    return;
  }
  if (locked.error.code === 'vault_unavailable') {
    logger.info('vault backend already stopped; its session went with it');
    return;
  }
  logger.warn({ err: locked.error }, 'vault lock failed');
}

export interface VaultSupervisorDependencies {
  /**
  The parent environment; only `PATH`, `HOME` and `TMPDIR` reach the CLI.
  */
  readonly environment: Environment;
  /**
  The account-page connection as stored, if any; it outranks the environment (VAULT-18).
  */
  readonly stored?: StoredVaultSettings;
  readonly spawn?: SpawnFunction;
  readonly clock?: Clock;
  readonly fetch?: FetchFunction;
  readonly allocatePort?: () => Promise<number>;
  /**
  Deletes a retired CLI app-data generation (VAULT-8); `rm -rf` semantics, absent is fine.
  */
  readonly removeDirectory?: RemoveDirectory;
}

interface ResolvedDependencies {
  readonly environment: Environment;
  readonly stored: StoredVaultSettings;
  readonly spawn: SpawnFunction;
  readonly clock: Clock;
  readonly fetch: FetchFunction;
  readonly allocatePort: () => Promise<number>;
  readonly removeDirectory: RemoveDirectory;
}

export const removeDirectoryFromDisk: RemoveDirectory = (path) =>
  rm(path, { recursive: true, force: true });

/**
Fills in the real process, clock, network, port allocation and filesystem where a test injected nothing.
*/
export function resolveDependencies(
  dependencies: VaultSupervisorDependencies,
): ResolvedDependencies {
  return {
    environment: dependencies.environment,
    stored: dependencies.stored ?? { kind: 'none' },
    spawn: dependencies.spawn ?? spawnChild,
    clock: dependencies.clock ?? systemClock,
    fetch: dependencies.fetch ?? fetch,
    allocatePort: dependencies.allocatePort ?? allocateLoopbackPort,
    removeDirectory: dependencies.removeDirectory ?? removeDirectoryFromDisk,
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
The CLI's own name for the bitwarden.com default; `bw config server bitwarden.com` resets to it (VAULT-3).
*/
const DEFAULT_SERVER_SETTING = 'bitwarden.com';

/**
 * Logs in when the CLI reports `unauthenticated`, configuring the server
 * first (VAULT-3, 4). A reused app-data directory that still names a server
 * the connection no longer wants is reset to the default before login, so
 * the login can never go to the previous server.
 */
export async function ensureLoggedIn(
  cli: BwCli,
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
  const { server } = credentials;
  if (server !== undefined || status.value.serverUrl != null) {
    const configured = await cli.configureServer(server ?? DEFAULT_SERVER_SETTING);
    if (!configured.ok) {
      return configured;
    }
  }
  logger.info('logging in to bitwarden with the api key');
  return cli.login(credentials);
}

const START_FAILURE_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/^bw login /, 'Bitwarden rejected the API key; check the client id and the client secret'],
  [/^bw config /, 'the Bitwarden CLI rejected the server URL'],
  [/^bw status /, 'the Bitwarden CLI could not report its status'],
  [/master password/, 'the vault rejected the master password'],
  [/did not answer/, 'bw serve did not start in time'],
];

/**
 * A start failure as the account page may show it (VAULT-18): a fixed phrase
 * per cause, never the CLI's own output, which can name files and accounts
 * (VAULT-14). The underlying error is in the log.
 */
export function describeStartFailure(error: Error): string {
  if (error.name === 'VersionRefusedError') {
    return error.message;
  }
  const match = START_FAILURE_MESSAGES.find(([pattern]) => pattern.test(error.message));
  return match === undefined
    ? 'the vault backend could not start; the server log has the reason'
    : match[1];
}
