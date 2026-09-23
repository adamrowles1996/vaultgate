/**
 * One credential generation and how it is brought up (VAULT-3, 4, 5, 8):
 * its own CLI app-data directory, then version gate, login, spawn, unlock
 * and the initial sync. The supervisor owns when this runs and what happens
 * when it fails.
 */
import { join } from 'node:path';

import { fail, ok, type Result } from '../result.ts';

import { BwCli, type ServeHandle, type SpawnFunction } from './serve-process.ts';
import { ensureLoggedIn, isServeSettling, SERVE_SETTLE_POLL_MS } from './supervisor-support.ts';
import { messageDataSchema, statusDataSchema } from './types.ts';
import { formatVersion } from './versions.ts';

import type { BwServeApi } from './api.ts';
import type { Clock } from './clock.ts';
import type { Credentials } from './credentials.ts';
import type { Config, Environment } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultCredentialOrigin } from '../vault/connection.ts';

/**
One set of credentials with the CLI app-data directory that belongs to it (VAULT-8).
*/
export interface Generation {
  readonly origin: Exclude<VaultCredentialOrigin, 'none'>;
  readonly credentials: Credentials;
  readonly cli: BwCli;
  readonly appDataDirectory: string;
}

export interface GenerationFactoryOptions {
  readonly config: Pick<Config, 'dataDir' | 'bitwarden'>;
  readonly environment: Environment;
  readonly spawn: SpawnFunction;
  readonly clock: Clock;
}

/**
Numbers generations from 1; each gets `${dataDir}/bw/<n>` so no two ever share a CLI session.
*/
export class GenerationFactory {
  readonly #options: GenerationFactoryOptions;
  #count = 0;

  constructor(options: GenerationFactoryOptions) {
    this.#options = options;
  }

  create(credentials: Credentials, origin: Generation['origin']): Generation {
    this.#count += 1;
    const { config, environment, spawn, clock } = this.#options;
    const appDataDirectory = join(config.dataDir, 'bw', String(this.#count));
    const cli = new BwCli({
      bin: config.bitwarden.bin,
      appDataDirectory,
      environment,
      spawn,
      clock,
    });
    return { origin, credentials, cli, appDataDirectory };
  }
}

export interface StarterDependencies {
  readonly api: BwServeApi;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly allocatePort: () => Promise<number>;
  readonly initialSync: () => Promise<void>;
  /**
  Whether the supervisor has asked everything to stop; polling ends at once then.
  */
  readonly isHalted: () => boolean;
  readonly pause: (delayMs: number) => Promise<void>;
  /**
  Makes `serve` the endpoint the API talks to, and forgets it again.
  */
  readonly attach: (serve: ServeHandle) => void;
  readonly detach: () => Promise<void>;
}

const SERVE_START_TIMEOUT_MS = 30_000;
const SERVE_START_POLL_MS = 250;
const STATUS_REQUEST = { method: 'GET', path: '/status', schema: statusDataSchema } as const;

export class GenerationStarter {
  readonly #dependencies: StarterDependencies;

  constructor(dependencies: StarterDependencies) {
    this.#dependencies = dependencies;
  }

  async #awaitServe(): Promise<Result<void>> {
    const { api, clock, isHalted, pause } = this.#dependencies;
    const deadline = clock.now() + SERVE_START_TIMEOUT_MS;
    while (clock.now() < deadline && !isHalted()) {
      const status = await api.call(STATUS_REQUEST);
      if (status.ok) {
        return ok(undefined);
      }
      await pause(SERVE_START_POLL_MS);
    }
    return fail(new Error('bw serve did not answer /status in time'));
  }

  // `POST /unlock`; a protocol error inside the settle window after `spawnedAt` is retried (VAULT-6).
  async #unlock(credentials: Credentials, spawnedAt: number): Promise<Result<void>> {
    const { api, clock, logger, isHalted, pause } = this.#dependencies;
    const unlocked = await api.call({
      method: 'POST',
      path: '/unlock',
      body: { password: credentials.masterPassword() },
      schema: messageDataSchema,
    });
    if (unlocked.ok || !isServeSettling(unlocked.error, spawnedAt, clock.now())) {
      return unlocked.ok ? ok(undefined) : fail(unlocked.error);
    }
    logger.debug({ err: unlocked.error }, 'bw serve is still settling; retrying unlock');
    await pause(SERVE_SETTLE_POLL_MS);
    return isHalted()
      ? fail(new Error('stopped while unlocking'))
      : this.#unlock(credentials, spawnedAt);
  }

  /**
  Version gate, login, spawn, unlock, initial sync; on failure no child is left running.
  */
  async start({ cli, credentials }: Generation): Promise<Result<ServeHandle>> {
    const { logger, clock, allocatePort, attach, detach, initialSync } = this.#dependencies;
    const version = await cli.version();
    if (!version.ok) {
      return version;
    }
    logger.info({ version: formatVersion(version.value) }, 'bitwarden cli version');
    const loggedIn = await ensureLoggedIn(cli, credentials, logger);
    if (!loggedIn.ok) {
      return loggedIn;
    }
    const spawnedAt = clock.now();
    const serve = cli.serve(await allocatePort());
    attach(serve);
    const started = await this.#awaitServe();
    const unlocked = started.ok ? await this.#unlock(credentials, spawnedAt) : started;
    if (!unlocked.ok) {
      await detach();
      return unlocked;
    }
    await initialSync();
    return ok(serve);
  }
}
