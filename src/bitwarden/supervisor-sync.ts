/**
 * The sync side of the supervisor (VAULT-9, VAULT-17, VAULT-19): the initial
 * sync after unlock, the scheduled ones after it, the operator's "sync now",
 * one retry for a `/sync` answered without its envelope, and the record that
 * `/readyz` reports. One sync runs at a time: a request while one is running
 * joins it. A failed sync never touches readiness or the restart counter; the
 * child's exit does that.
 */
import { type Clock, sleep, type Sleep } from './clock.ts';

import type { Logger } from '../logger.ts';
import type { Result } from '../result.ts';
import type { VaultClient, VaultError, VaultErrorCode } from '../vault/client.ts';

export interface SyncState {
  /**
  ISO 8601 time of the last successful sync since start-up, or `null` before one.
  */
  readonly lastSyncAt: string | null;
  /**
  The code of the most recent failure; `null` once a later sync succeeds.
  */
  readonly lastSyncError: VaultErrorCode | null;
}

export interface VaultSyncRunnerOptions {
  readonly client: VaultClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  /**
  Whether `bw serve` is still running; a protocol error is retried only while it is.
  */
  readonly isChildAlive: () => boolean;
}

type SyncKind = 'initial' | 'scheduled' | 'manual';

/**
How long after a `/sync` protocol error the one retry waits (VAULT-17).
*/
export const SYNC_PROTOCOL_RETRY_MS = 2000;

export class VaultSyncRunner {
  readonly #options: VaultSyncRunnerOptions;
  #lastSyncAt: string | null = null;
  #lastSyncError: VaultErrorCode | null = null;
  #cancelScheduled: (() => void) | undefined;
  #retryPause: Sleep | undefined;
  #isScheduling = false;
  #inFlight: Promise<Result<void, VaultError>> | undefined;

  constructor(options: VaultSyncRunnerOptions) {
    this.#options = options;
  }

  #schedule(): void {
    this.#cancelScheduled = this.#options.clock.schedule(() => {
      void this.#sync('scheduled').then(() => {
        if (this.#isScheduling) {
          this.#schedule();
        }
      });
    }, this.#options.intervalMs);
  }

  /**
  `true` when the child is alive and the retry delay passed without a `stop` (VAULT-17).
  */
  async #shouldRetry(error: VaultError): Promise<boolean> {
    if (error.code !== 'vault_protocol_error' || !this.#options.isChildAlive()) {
      return false;
    }
    this.#options.logger.debug(
      { err: error },
      'vault sync answered without its envelope; retrying',
    );
    this.#retryPause = sleep(this.#options.clock, SYNC_PROTOCOL_RETRY_MS);
    const outcome = await this.#retryPause.done;
    this.#retryPause = undefined;
    return outcome === 'elapsed';
  }

  async #attempt(): Promise<Result<void, VaultError>> {
    const first = await this.#options.client.sync();
    return !first.ok && (await this.#shouldRetry(first.error))
      ? this.#options.client.sync()
      : first;
  }

  async #run(kind: SyncKind): Promise<Result<void, VaultError>> {
    const { clock, logger } = this.#options;
    const startedAt = clock.now();
    const synced = await this.#attempt();
    const durationMs = clock.now() - startedAt;
    if (synced.ok) {
      this.#lastSyncAt = new Date(clock.now()).toISOString();
      this.#lastSyncError = null;
      logger.info({ kind, durationMs }, 'vault synced');
      return synced;
    }
    this.#lastSyncError = synced.error.code;
    logger.warn(
      { err: synced.error, kind, durationMs },
      kind === 'initial' ? 'initial vault sync failed' : 'vault sync failed',
    );
    return synced;
  }

  async #runAlone(kind: SyncKind): Promise<Result<void, VaultError>> {
    try {
      return await this.#run(kind);
    } finally {
      this.#inFlight = undefined;
    }
  }

  /**
  The sync already running, or a new one of `kind` (VAULT-19).
  */
  #sync(kind: SyncKind): Promise<Result<void, VaultError>> {
    this.#inFlight ??= this.#runAlone(kind);
    return this.#inFlight;
  }

  state(): SyncState {
    return { lastSyncAt: this.#lastSyncAt, lastSyncError: this.#lastSyncError };
  }

  /**
  The first sync after unlock; a failure is logged and nothing more (VAULT-9).
  */
  async initial(): Promise<void> {
    await this.#sync('initial');
  }

  /**
  A sync at the operator's request, joined with one already running (VAULT-19).
  */
  syncNow(): Promise<Result<void, VaultError>> {
    return this.#sync('manual');
  }

  /**
  Syncs every interval from now until `stop`.
  */
  start(): void {
    this.#isScheduling = true;
    this.#schedule();
  }

  /**
  Ends the schedule and abandons a retry still waiting; a sync in flight finishes on its own.
  */
  stop(): void {
    this.#isScheduling = false;
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    this.#retryPause?.cancel();
  }
}
