import { setImmediate as flushMacrotask } from 'node:timers/promises';

import { startVaultSupervisor } from '../bitwarden/index.ts';
import { loadConfig } from '../config/index.ts';

import { FakeBwServe } from './fake-bw-serve.ts';
import { FakeSpawner, type SpawnRecord } from './fake-child-process.ts';
import { CANARY } from './fake-vault-fixture.ts';
import { captureLogger } from './logging.ts';
import { ManualClock } from './manual-clock.ts';
import { unwrapOk } from './result.ts';

import type { FetchFunction } from '../bitwarden/api.ts';
import type { StoredVaultSettings } from '../bitwarden/settings.ts';
import type { VaultSupervisor } from '../bitwarden/supervisor.ts';
import type { Config } from '../config/index.ts';

const HARNESS_PORT = 43_210;
export const CLIENT_ID = 'user.harness';
export const CLIENT_SECRET = 'CANARY-CLIENT-SECRET';

const UNAUTHENTICATED = '{"serverUrl":null,"lastSync":null,"status":"unauthenticated"}';
const MAX_TURNS = 200;

/**
The environment-seeded configuration; an override of `undefined` removes a variable.
*/
export function harnessConfig(environment: Record<string, string | undefined> = {}): Config {
  const loaded = loadConfig({
    VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
    VAULTGATE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    VAULTGATE_BW_PASSWORD: CANARY.masterPassword,
    VAULTGATE_BW_CLIENT_ID: CLIENT_ID,
    VAULTGATE_BW_CLIENT_SECRET: CLIENT_SECRET,
    VAULTGATE_BW_SYNC_INTERVAL: '1m',
    VAULTGATE_DATA_DIR: '/data',
    ...environment,
  });
  return unwrapOk(loaded).config;
}

function finishing(stdout: string, code = 0): (record: SpawnRecord) => void {
  return ({ child }) => {
    child.finish(stdout, code);
  };
}

export interface HarnessOptions {
  readonly config?: Config;
  readonly fake?: FakeBwServe;
  readonly fetch?: FetchFunction;
  /**
  The account-page connection as the store holds it; none by default.
  */
  readonly stored?: StoredVaultSettings;
}

/**
 * Everything a supervisor test needs: a scripted CLI whose commands succeed by
 * default, a locked fake vault behind `fetch`, a manual clock and captured
 * logs. `until` drives the event loop without touching the wall clock.
 */
export class SupervisorHarness {
  readonly clock = new ManualClock();
  readonly spawner = new FakeSpawner({
    '--version': finishing('2026.9.0\n'),
    status: finishing(UNAUTHENTICATED),
    config: finishing('Saved setting `config`.\n'),
    login: finishing('You are logged in!\n'),
  });
  readonly logs = captureLogger();
  readonly config: Config;
  readonly fake: FakeBwServe;
  readonly fetch: FetchFunction;
  readonly stored: StoredVaultSettings;
  /**
  Every app-data directory the supervisor asked to remove, in order (VAULT-8).
  */
  readonly removed: string[] = [];

  constructor(options: HarnessOptions = {}) {
    this.config = options.config ?? harnessConfig();
    this.fake = options.fake ?? new FakeBwServe({ state: 'locked' });
    this.fetch = options.fetch ?? this.fake.fetch;
    this.stored = options.stored ?? { kind: 'none' };
  }

  start(): VaultSupervisor {
    return startVaultSupervisor(this.config, this.logs.logger, {
      environment: { PATH: '/usr/bin', HOME: '/home/vaultgate', SECRET_THING: 'leak' },
      stored: this.stored,
      spawn: this.spawner.spawn,
      clock: this.clock,
      fetch: this.fetch,
      allocatePort: () => Promise.resolve(HARNESS_PORT),
      removeDirectory: (path) => {
        this.removed.push(path);
        return Promise.resolve();
      },
    });
  }

  /**
  Yields to the event loop until `predicate` holds; fails the test if it never does.
  */
  async until(isDone: () => boolean): Promise<void> {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (isDone()) {
        return;
      }
      await flushMacrotask();
    }
    throw new Error('condition not met within the turn budget');
  }

  messages(): string[] {
    return this.logs.lines().map((line) => String(line['msg']));
  }

  linesFor(message: string): Record<string, unknown>[] {
    return this.logs.lines().filter((line) => line['msg'] === message);
  }

  serveChild(index = 0): SpawnRecord['child'] {
    const record = this.spawner.spawned('serve')[index];
    if (record === undefined) {
      throw new Error(`no serve child ${index}`);
    }
    return record.child;
  }
}
