/**
 * Owns the vault backend's lifecycle: start `bw serve`, log in, unlock, sync,
 * declare readiness, restart with backoff when the child dies (VAULT-5, 6, 9)
 * and lock and stop it on shutdown (VAULT-7). The HTTP layer only ever sees
 * `isReady()` and the `VaultClient`.
 */
import { fail, ok, type Result } from '../result.ts';

import { BwServeApi, type FetchFunction } from './api.ts';
import { type Clock, sleep, type Sleep, systemClock } from './clock.ts';
import { Credentials } from './credentials.ts';
import { allocateLoopbackPort } from './ports.ts';
import { BwCli, type ServeHandle, spawnChild, type SpawnFunction } from './serve-process.ts';
import { messageDataSchema, statusDataSchema } from './types.ts';
import { BwServeVaultClient } from './vault-client.ts';
import { formatVersion } from './versions.ts';

import type { Config, Environment } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultClient } from '../vault/client.ts';

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

export interface VaultSupervisor {
  readonly client: VaultClient;
  isReady(): boolean;
  stop(): Promise<void>;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const ERROR_LEVEL_AFTER_FAILURES = 10;
const SERVE_START_TIMEOUT_MS = 30_000;
const SERVE_START_POLL_MS = 250;

export function backoffMs(consecutiveFailures: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(consecutiveFailures - 1, 0), MAX_BACKOFF_MS);
}

class Supervisor implements VaultSupervisor {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #allocatePort: () => Promise<number>;
  readonly #cli: BwCli;
  readonly #credentials: Credentials;
  readonly #api: BwServeApi;
  #serve: ServeHandle | undefined;
  #ready = false;
  #stopping = false;
  #failures = 0;
  #waiting: Sleep | undefined;
  #cancelSync: (() => void) | undefined;
  #loop: Promise<void> = Promise.resolve();
  readonly client: VaultClient;

  constructor(config: Config, logger: Logger, dependencies: VaultSupervisorDependencies) {
    this.#config = config;
    this.#logger = logger;
    this.#clock = dependencies.clock ?? systemClock;
    this.#allocatePort = dependencies.allocatePort ?? allocateLoopbackPort;
    this.#credentials = new Credentials(
      config.bitwarden.clientId,
      config.secrets.masterPassword,
      config.secrets.clientSecret,
    );
    this.#cli = new BwCli({
      bin: config.bitwarden.bin,
      dataDir: config.dataDir,
      environment: dependencies.environment,
      spawn: dependencies.spawn ?? spawnChild,
      clock: this.#clock,
    });
    this.#api = new BwServeApi(() => this.#serve?.endpoint, dependencies.fetch ?? fetch);
    const options = { api: this.#api, clock: this.#clock };
    this.client = new BwServeVaultClient(
      config.bitwarden.server === undefined
        ? options
        : { ...options, serverUrl: config.bitwarden.server },
    );
  }

  /**
  Logs in when the CLI reports `unauthenticated`, configuring the server first (VAULT-3, 4).
  */
  async #ensureLoggedIn(): Promise<Result<void>> {
    const status = await this.#cli.status();
    if (!status.ok) {
      return status;
    }
    if (status.value.status !== 'unauthenticated') {
      return ok(undefined);
    }
    const server = this.#config.bitwarden.server;
    if (server !== undefined) {
      const configured = await this.#cli.configureServer(server);
      if (!configured.ok) {
        return configured;
      }
    }
    this.#logger.info('logging in to bitwarden with the api key');
    return this.#cli.login(this.#credentials);
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
      const status = await this.#api.call({
        method: 'GET',
        path: '/status',
        schema: statusDataSchema,
      });
      if (status.ok) {
        return ok(undefined);
      }
      await this.#pause(SERVE_START_POLL_MS);
    }
    return fail(new Error('bw serve did not answer /status in time'));
  }

  async #unlock(): Promise<Result<void>> {
    const unlocked = await this.#api.call({
      method: 'POST',
      path: '/unlock',
      body: { password: this.#credentials.masterPassword() },
      schema: messageDataSchema,
    });
    return unlocked.ok ? ok(undefined) : fail(unlocked.error);
  }

  /**
  One start-up: version gate, login, spawn, unlock, initial sync.
  */
  async #attempt(): Promise<Result<void>> {
    const version = await this.#cli.version();
    if (!version.ok) {
      return version;
    }
    this.#logger.info({ version: formatVersion(version.value) }, 'bitwarden cli version');
    const loggedIn = await this.#ensureLoggedIn();
    if (!loggedIn.ok) {
      return loggedIn;
    }
    this.#serve = this.#cli.serve(await this.#allocatePort());
    const started = await this.#awaitServe();
    const unlocked = started.ok ? await this.#unlock() : started;
    if (!unlocked.ok) {
      await this.#stopServe();
      return unlocked;
    }
    const synced = await this.client.sync();
    if (!synced.ok) {
      this.#logger.warn({ err: synced.error }, 'initial vault sync failed');
    }
    return ok(undefined);
  }

  async #stopServe(): Promise<void> {
    const serve = this.#serve;
    if (serve === undefined) {
      return;
    }
    this.#serve = undefined;
    await serve.stop();
  }

  #scheduleSync(): void {
    this.#cancelSync = this.#clock.schedule(() => {
      void this.#runSync();
    }, this.#config.bitwarden.syncIntervalMs);
  }

  async #runSync(): Promise<void> {
    const synced = await this.client.sync();
    if (synced.ok) {
      this.#logger.debug('vault synced');
    } else {
      this.#logger.warn({ err: synced.error }, 'vault sync failed');
    }
    if (this.#ready) {
      this.#scheduleSync();
    }
  }

  #becomeUnready(): void {
    this.#ready = false;
    this.#cancelSync?.();
    this.#cancelSync = undefined;
  }

  /**
  Serves until the child exits; `true` when that was our own shutdown.
  */
  async #serveUntilExit(): Promise<boolean> {
    const serve = this.#serve;
    if (serve === undefined) {
      return this.#stopping;
    }
    this.#failures = 0;
    this.#ready = true;
    this.#logger.info('vault ready');
    this.#scheduleSync();
    const exit = await serve.exited;
    this.#becomeUnready();
    this.#serve = undefined;
    if (!this.#stopping) {
      this.#logger.warn(exit, 'bw serve exited');
    }
    return this.#stopping;
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
        const isStopped = await this.#serveUntilExit();
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

  /**
  Lock, stop the child, zero the credentials (VAULT-7, VAULT-15). Never logs out (VAULT-8).
  */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#waiting?.cancel();
    this.#becomeUnready();
    if (this.#serve !== undefined) {
      await this.#api.call({ method: 'POST', path: '/lock', schema: messageDataSchema });
      await this.#stopServe();
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
