/**
 * Owns the vault backend's lifecycle: start `bw serve`, log in, unlock, sync,
 * declare readiness, restart with backoff when the child dies (VAULT-5, 6, 9),
 * switch to a new credential generation on request (VAULT-18) and lock and
 * stop it on shutdown (VAULT-7). The HTTP layer only ever sees `isReady()`,
 * `source()`, `syncState()` and the `VaultClient`.
 */
import { fail, ok, type Result } from '../result.ts';
import { VaultError } from '../vault/client.ts';

import { BwServeApi } from './api.ts';
import { type Clock, sleep, type Sleep } from './clock.ts';
import { resolveCredentials } from './credential-source.ts';
import { Credentials, type CredentialValues } from './credentials.ts';
import { DEFAULT_SERVER_URL } from './requests.ts';
import { RestartLoop } from './supervisor-loop.ts';
import { type Generation, GenerationFactory, GenerationStarter } from './supervisor-start.ts';
import {
  describeStartFailure,
  type RemoveDirectory,
  resolveDependencies,
  type VaultSupervisorDependencies,
} from './supervisor-support.ts';
import { type SyncState, VaultSyncRunner } from './supervisor-sync.ts';
import { messageDataSchema } from './types.ts';
import { BwServeVaultClient } from './vault-client.ts';

import type { ServeHandle } from './serve-process.ts';
import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultClient } from '../vault/client.ts';
import type { VaultCredentialOrigin } from '../vault/connection.ts';

/**
Where the running credentials came from and which server they name (VAULT-18).
*/
interface VaultSource {
  readonly origin: VaultCredentialOrigin;
  readonly serverUrl: string;
}

export interface VaultSupervisor {
  readonly client: VaultClient;
  isReady(): boolean;
  source(): VaultSource;
  /**
  The generation in use, for the account page to keep a secret the operator left blank.
  */
  credentials(): Credentials | undefined;
  /**
  When the vault last synced and how the last sync failed, for `/readyz` (VAULT-9).
  */
  syncState(): SyncState;
  /**
  Switches to `values` in a fresh CLI app-data generation; a failure restores what ran before (VAULT-18).
  */
  reconfigure(values: CredentialValues): Promise<Result<void, VaultError>>;
  stop(): Promise<void>;
}

class Supervisor implements VaultSupervisor {
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #removeDirectory: RemoveDirectory;
  readonly #api: BwServeApi;
  readonly #syncRunner: VaultSyncRunner;
  readonly #generations: GenerationFactory;
  readonly #starter: GenerationStarter;
  readonly #restartLoop: RestartLoop;
  #generation: Generation | undefined;
  #serve: ServeHandle | undefined;
  #isReady = false;
  #isHalted = false;
  #isStopping = false;
  #waiting: Sleep | undefined;
  #loop: Promise<void> = Promise.resolve();
  #switching: Promise<unknown> | undefined;
  readonly client: VaultClient;

  constructor(config: Config, logger: Logger, dependencies: VaultSupervisorDependencies) {
    this.#logger = logger;
    const resolved = resolveDependencies(dependencies);
    this.#clock = resolved.clock;
    this.#removeDirectory = resolved.removeDirectory;
    this.#generations = new GenerationFactory({ config, ...resolved });
    const initial = resolveCredentials(config, resolved.stored, logger);
    if (initial !== undefined) {
      this.#generation = this.#generations.create(initial.credentials, initial.origin);
    }
    this.#api = new BwServeApi(() => this.#serve?.endpoint, resolved.fetch, this.#clock);
    this.client = new BwServeVaultClient({
      api: this.#api,
      clock: this.#clock,
      serverUrl: () => this.#generation?.credentials.server,
    });
    this.#syncRunner = new VaultSyncRunner({
      client: this.client,
      clock: this.#clock,
      logger,
      intervalMs: config.bitwarden.syncIntervalMs,
      isChildAlive: () => this.#serve !== undefined && !this.#isHalted,
    });
    this.#starter = new GenerationStarter({
      api: this.#api,
      clock: this.#clock,
      logger,
      allocatePort: resolved.allocatePort,
      initialSync: () => this.#syncRunner.initial(),
      isHalted: () => this.#isHalted,
      pause: (delayMs) => this.#pause(delayMs),
      attach: (serve) => {
        this.#serve = serve;
      },
      detach: () => this.#stopServe(),
    });
    this.#restartLoop = new RestartLoop({
      logger,
      clock: this.#clock,
      starter: this.#starter,
      pause: (delayMs) => this.#pause(delayMs),
      isHalted: () => this.#isHalted,
      generation: () => this.#generation,
      onReady: () => {
        this.#isReady = true;
        this.#syncRunner.start();
      },
      onExit: () => {
        this.#becomeUnready();
        this.#serve = undefined;
      },
    });
  }

  /**
  A pause that `stop()` or a reconfiguration can cut short.
  */
  async #pause(delayMs: number): Promise<void> {
    this.#waiting = sleep(this.#clock, delayMs);
    await this.#waiting.done;
    this.#waiting = undefined;
  }

  async #stopServe(): Promise<void> {
    const serve = this.#serve;
    if (serve === undefined) {
      return;
    }
    this.#serve = undefined;
    await serve.stop();
  }

  #becomeUnready(): void {
    this.#isReady = false;
    this.#syncRunner.stop();
  }

  /**
  Ends the loop: lock, stop the child, wait for the loop to notice (VAULT-7). Never logs out (VAULT-8).
  */
  async #halt(): Promise<void> {
    this.#isHalted = true;
    this.#waiting?.cancel();
    this.#generation?.cli.abort();
    this.#becomeUnready();
    if (this.#serve !== undefined) {
      const locked = await this.#api.call({
        method: 'POST',
        path: '/lock',
        schema: messageDataSchema,
      });
      this.#recordLock(locked);
      await this.#stopServe();
      this.#logger.info('bw serve stopped');
    }
    await this.#loop;
  }

  /**
   * A lock on the way down (VAULT-7). A backend that has gone cannot be
   * locked and need not be, its session having died with it, so a clean stop
   * logs no warning; a reachable vault that refuses still does.
   */
  #recordLock(locked: Result<unknown, VaultError>): void {
    if (locked.ok) {
      this.#logger.info('vault locked');
      return;
    }
    if (locked.error.code === 'vault_unavailable') {
      this.#logger.info('vault backend already stopped; its session went with it');
      return;
    }
    this.#logger.warn({ err: locked.error }, 'vault lock failed');
  }

  /**
  Read through a call so a halt that arrived during an `await` is not narrowed away.
  */
  #hasHalted(): boolean {
    return this.#isHalted;
  }

  /**
  Retires a generation: zero its secrets and delete its app-data directory (VAULT-8, VAULT-15).
  */
  async #retire(generation: Generation): Promise<void> {
    generation.credentials.dispose();
    await this.#removeDirectory(generation.appDataDirectory);
  }

  /**
  Halts the current generation, starts the next in a fresh app-data directory, and on failure
  restores the previous one (or the unconfigured state) before reporting why (VAULT-18).
  */
  async #switch(values: CredentialValues): Promise<Result<void, VaultError>> {
    const previous = this.#generation;
    await this.#halt();
    const next = this.#generations.create(new Credentials(values), 'settings');
    this.#generation = next;
    await this.#removeDirectory(next.appDataDirectory);
    this.#isHalted = false;
    this.#restartLoop.resetFailures();
    const attempt = await this.#starter.start(next);
    if (attempt.ok && !this.#hasHalted()) {
      if (previous !== undefined) {
        await this.#retire(previous);
      }
      this.#logger.info({ server: this.source().serverUrl }, 'vault reconfigured');
      this.#loop = this.#restartLoop.run(attempt.value);
      return ok(undefined);
    }
    const error = attempt.ok ? new Error('stopped while reconfiguring') : attempt.error;
    await this.#stopServe();
    await this.#retire(next);
    this.#generation = previous;
    this.#logger.warn({ err: error }, 'vault reconfiguration failed');
    if (!this.#isStopping) {
      this.#isHalted = false;
      this.start();
    }
    return fail(new VaultError('vault_unavailable', describeStartFailure(error)));
  }

  start(): void {
    this.#loop = this.#restartLoop.run();
  }

  isReady(): boolean {
    return this.#isReady;
  }

  source(): VaultSource {
    const generation = this.#generation;
    return {
      origin: generation?.origin ?? 'none',
      serverUrl: generation?.credentials.server ?? DEFAULT_SERVER_URL,
    };
  }

  credentials(): Credentials | undefined {
    return this.#generation?.credentials;
  }

  syncState(): SyncState {
    return this.#syncRunner.state();
  }

  async reconfigure(values: CredentialValues): Promise<Result<void, VaultError>> {
    if (this.#isStopping || this.#switching !== undefined) {
      const reason = this.#isStopping ? 'shutting down' : 'busy switching connections';
      return fail(new VaultError('vault_unavailable', `the vault backend is ${reason}`));
    }
    const switching = this.#switch(values);
    this.#switching = switching;
    try {
      return await switching;
    } finally {
      this.#switching = undefined;
    }
  }

  /**
  Lock, stop the child, zero the credentials (VAULT-7, VAULT-15). Never logs out (VAULT-8).
  */
  async stop(): Promise<void> {
    this.#isStopping = true;
    await this.#halt();
    await this.#switching;
    this.#generation?.credentials.dispose();
  }
}

export function startVaultSupervisor(
  config: Config,
  logger: Logger,
  dependencies: VaultSupervisorDependencies,
): VaultSupervisor {
  const supervisor = new Supervisor(config, logger, dependencies);
  supervisor.start();
  return supervisor;
}
