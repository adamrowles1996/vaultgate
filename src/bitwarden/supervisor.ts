/**
 * Owns the vault backend's lifecycle: start `bw serve`, log in, unlock, sync,
 * declare readiness, restart with backoff when the child dies (VAULT-5, 6, 9)
 * and lock and stop it on shutdown (VAULT-7). The HTTP layer only ever sees
 * `isReady()`, `syncState()` and the `VaultClient`.
 */
import { fail, ok, type Result } from '../result.ts';

import { BwServeApi } from './api.ts';
import { type Clock, sleep, type Sleep } from './clock.ts';
import { Credentials } from './credentials.ts';
import { BwCli, type ServeHandle } from './serve-process.ts';
import {
  backoffMs,
  ensureLoggedIn,
  isServeSettling,
  MIN_HEALTHY_UPTIME_MS,
  resolveDependencies,
  SERVE_SETTLE_POLL_MS,
  type VaultSupervisorDependencies,
} from './supervisor-support.ts';
import { type SyncState, VaultSyncRunner } from './supervisor-sync.ts';
import { messageDataSchema, statusDataSchema } from './types.ts';
import { BwServeVaultClient } from './vault-client.ts';
import { formatVersion } from './versions.ts';

import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultClient } from '../vault/client.ts';

export interface VaultSupervisor {
  readonly client: VaultClient;
  isReady(): boolean;
  /**
  When the vault last synced and how the last sync failed, for `/readyz` (VAULT-9).
  */
  syncState(): SyncState;
  stop(): Promise<void>;
}

const ERROR_LEVEL_AFTER_FAILURES = 10;
const SERVE_START_TIMEOUT_MS = 30_000;
const SERVE_START_POLL_MS = 250;
const STATUS_REQUEST = { method: 'GET', path: '/status', schema: statusDataSchema } as const;

class Supervisor implements VaultSupervisor {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #allocatePort: () => Promise<number>;
  readonly #cli: BwCli;
  readonly #credentials: Credentials;
  readonly #api: BwServeApi;
  readonly #syncRunner: VaultSyncRunner;
  #serve: ServeHandle | undefined;
  #ready = false;
  #stopping = false;
  #failures = 0;
  #waiting: Sleep | undefined;
  #loop: Promise<void> = Promise.resolve();
  readonly client: VaultClient;

  constructor(config: Config, logger: Logger, dependencies: VaultSupervisorDependencies) {
    this.#config = config;
    this.#logger = logger;
    const resolved = resolveDependencies(dependencies);
    this.#clock = resolved.clock;
    this.#allocatePort = resolved.allocatePort;
    this.#credentials = new Credentials(
      config.bitwarden.clientId,
      config.secrets.masterPassword,
      config.secrets.clientSecret,
    );
    this.#cli = new BwCli({
      bin: config.bitwarden.bin,
      dataDir: config.dataDir,
      environment: resolved.environment,
      spawn: resolved.spawn,
      clock: this.#clock,
    });
    this.#api = new BwServeApi(() => this.#serve?.endpoint, resolved.fetch, this.#clock);
    const options = { api: this.#api, clock: this.#clock };
    this.client = new BwServeVaultClient(
      config.bitwarden.server === undefined
        ? options
        : { ...options, serverUrl: config.bitwarden.server },
    );
    this.#syncRunner = new VaultSyncRunner({
      client: this.client,
      clock: this.#clock,
      logger,
      intervalMs: config.bitwarden.syncIntervalMs,
      isChildAlive: () => this.#serve !== undefined && !this.#stopping,
    });
  }

  /**
  A pause that `stop()` can cut short.
  */
  async #pause(delayMs: number): Promise<void> {
    this.#waiting = sleep(this.#clock, delayMs);
    await this.#waiting.done;
    this.#waiting = undefined;
  }

  async #awaitServe(): Promise<Result<void>> {
    const deadline = this.#clock.now() + SERVE_START_TIMEOUT_MS;
    while (this.#clock.now() < deadline && !this.#stopping) {
      const status = await this.#api.call(STATUS_REQUEST);
      if (status.ok) {
        return ok(undefined);
      }
      await this.#pause(SERVE_START_POLL_MS);
    }
    return fail(new Error('bw serve did not answer /status in time'));
  }

  // `POST /unlock`; a protocol error inside the settle window after `spawnedAt` is retried (VAULT-6).
  async #unlock(spawnedAt: number): Promise<Result<void>> {
    const unlocked = await this.#api.call({
      method: 'POST',
      path: '/unlock',
      body: { password: this.#credentials.masterPassword() },
      schema: messageDataSchema,
    });
    if (unlocked.ok || !isServeSettling(unlocked.error, spawnedAt, this.#clock.now())) {
      return unlocked.ok ? ok(undefined) : fail(unlocked.error);
    }
    this.#logger.debug({ err: unlocked.error }, 'bw serve is still settling; retrying unlock');
    await this.#pause(SERVE_SETTLE_POLL_MS);
    return this.#stopping ? fail(new Error('stopped while unlocking')) : this.#unlock(spawnedAt);
  }

  /**
  One start-up: version gate, login, spawn, unlock, initial sync.
  */
  async #attempt(): Promise<Result<ServeHandle>> {
    const version = await this.#cli.version();
    if (!version.ok) {
      return version;
    }
    this.#logger.info({ version: formatVersion(version.value) }, 'bitwarden cli version');
    const loggedIn = await ensureLoggedIn(
      this.#cli,
      this.#config.bitwarden.server,
      this.#credentials,
      this.#logger,
    );
    if (!loggedIn.ok) {
      return loggedIn;
    }
    const spawnedAt = this.#clock.now();
    const serve = this.#cli.serve(await this.#allocatePort());
    this.#serve = serve;
    const started = await this.#awaitServe();
    const unlocked = started.ok ? await this.#unlock(spawnedAt) : started;
    if (!unlocked.ok) {
      await this.#stopServe();
      return unlocked;
    }
    await this.#syncRunner.initial();
    return ok(serve);
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
    this.#ready = false;
    this.#syncRunner.stop();
  }

  /**
  Serves until the child exits; `true` when that was our own shutdown. A child that
  was ready for `MIN_HEALTHY_UPTIME_MS` clears the failure count; an earlier exit
  counts as one more consecutive failure (VAULT-6).
  */
  async #serveUntilExit(serve: ServeHandle): Promise<boolean> {
    const readyAt = this.#clock.now();
    this.#ready = true;
    this.#logger.info('vault ready');
    this.#syncRunner.start();
    const exit = await serve.exited;
    this.#becomeUnready();
    this.#serve = undefined;
    if (this.#stopping) {
      return true;
    }
    const uptimeMs = this.#clock.now() - readyAt;
    if (uptimeMs >= MIN_HEALTHY_UPTIME_MS) {
      this.#failures = 0;
    }
    this.#logger.warn({ ...exit, uptimeMs, output: serve.output() }, 'bw serve exited');
    return false;
  }

  /**
  Exponential backoff between attempts; error level once a minute after ten failures (VAULT-6).
  */
  async #recordFailure(error: Error): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#failures += 1;
    const delayMs = backoffMs(this.#failures);
    const fields = { err: error, attempt: this.#failures, nextRetryMs: delayMs };
    if (this.#failures >= ERROR_LEVEL_AFTER_FAILURES) {
      this.#logger.error(fields, 'vault backend unavailable');
    } else {
      this.#logger.warn(fields, 'vault backend start failed');
    }
    await this.#pause(delayMs);
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      const attempt = await this.#attempt();
      if (attempt.ok) {
        const isStopped = await this.#serveUntilExit(attempt.value);
        if (isStopped) {
          return;
        }
        await this.#recordFailure(new Error('bw serve exited'));
      } else if (attempt.error.name === 'VersionRefusedError') {
        this.#logger.error({ err: attempt.error }, 'bitwarden cli refused');
        return;
      } else {
        await this.#recordFailure(attempt.error);
      }
    }
  }

  start(): void {
    this.#loop = this.#run();
  }

  isReady(): boolean {
    return this.#ready;
  }

  syncState(): SyncState {
    return this.#syncRunner.state();
  }

  /**
  Lock, stop the child, zero the credentials (VAULT-7, VAULT-15). Never logs out (VAULT-8).
  */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#waiting?.cancel();
    this.#cli.abort();
    this.#becomeUnready();
    if (this.#serve !== undefined) {
      const locked = await this.#api.call({
        method: 'POST',
        path: '/lock',
        schema: messageDataSchema,
      });
      if (locked.ok) {
        this.#logger.info('vault locked');
      } else {
        this.#logger.warn({ err: locked.error }, 'vault lock failed');
      }
      await this.#stopServe();
      this.#logger.info('bw serve stopped');
    }
    await this.#loop;
    this.#credentials.dispose();
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
