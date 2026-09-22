import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { CANARY, FIXTURE_IDS } from '../test-support/fake-vault-fixture.ts';
import { unwrapOk } from '../test-support/result.ts';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  harnessConfig,
  SupervisorHarness,
} from '../test-support/supervisor-harness.ts';

import { systemClock } from './clock.ts';
import { allocateLoopbackPort } from './ports.ts';
import { spawnChild } from './serve-process.ts';
import { backoffMs, resolveDependencies } from './supervisor-support.ts';

import type { FetchFunction } from './api.ts';

interface SyncGate {
  readonly fetch: FetchFunction;
  readonly syncsStarted: () => number;
  readonly release: () => void;
}

/**
A fetch that lets every request through except the second `/sync`, which waits for `release`.
*/
function holdingSecondSync(fake: FakeBwServe): SyncGate {
  const held = Promise.withResolvers<undefined>();
  let syncs = 0;
  const fetchFunction: FetchFunction = async (input, init) => {
    const isSync = new URL(input).pathname === '/sync';
    syncs += isSync ? 1 : 0;
    if (isSync && syncs === 2) {
      await held.promise;
    }
    return fake.fetch(input, init);
  };
  return {
    fetch: fetchFunction,
    syncsStarted: () => syncs,
    release: () => {
      held.resolve(undefined);
    },
  };
}

describe('startVaultSupervisor start-up', () => {
  it('VAULT-4 logs in, spawns bw serve, unlocks, syncs and reports ready', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    expect(supervisor.isReady()).toBe(false);
    await harness.until(() => supervisor.isReady());

    expect(harness.spawner.records.map((record) => record.argv[0])).toStrictEqual([
      '--version',
      'status',
      'login',
      'serve',
    ]);
    expect(harness.spawner.spawned('login')[0]?.environment).toMatchObject({
      BW_CLIENTID: CLIENT_ID,
      BW_CLIENTSECRET: CLIENT_SECRET,
    });
    expect(
      harness.fake.requests.map((request) => `${request.method} ${request.path}`),
    ).toStrictEqual(['GET /status', 'POST /unlock', 'POST /sync']);
    expect(harness.fake.requestsTo('/unlock')[0]?.body).toStrictEqual({
      password: CANARY.masterPassword,
    });
    expect(harness.fake.state).toBe('unlocked');
    expect(harness.linesFor('bitwarden cli version')[0]).toMatchObject({ version: '2026.9.0' });
    expect(harness.messages()).toContain('vault ready');
    await supervisor.stop();
  });

  it('VAULT-15 never writes the master password or client secret to the log', async () => {
    const harness = new SupervisorHarness({ fake: new FakeBwServe({ masterPassword: 'other' }) });
    const supervisor = harness.start();
    await harness.until(() => harness.messages().includes('vault backend start failed'));
    await supervisor.stop();
    const everything = JSON.stringify(harness.logs.lines());
    expect(everything).not.toContain(CANARY.masterPassword);
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(CANARY.sessionKey);
  });

  it('VAULT-1 hands the CLI a scrubbed environment', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.spawned('serve')[0]?.environment).toStrictEqual({
      PATH: '/usr/bin',
      HOME: '/home/vaultgate',
      BITWARDENCLI_APPDATA_DIR: '/data/bw',
      BW_NOINTERACTION: 'true',
    });
    await supervisor.stop();
  });

  it('VAULT-3 configures the server before logging in when one is set', async () => {
    const harness = new SupervisorHarness({
      config: harnessConfig({ VAULTGATE_BW_SERVER: 'https://vault.example.test' }),
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.records.map((record) => record.argv)).toStrictEqual([
      ['--version'],
      ['status'],
      ['config', 'server', 'https://vault.example.test'],
      ['login', '--apikey'],
      ['serve', '--hostname', '127.0.0.1', '--port', '43210'],
    ]);
    await supervisor.stop();
  });

  it('VAULT-4 skips login when the CLI is already authenticated', async () => {
    const harness = new SupervisorHarness({
      config: harnessConfig({ VAULTGATE_BW_SERVER: 'bitwarden.eu' }),
    });
    harness.spawner.on('status', ({ child }) => {
      child.finish('{"serverUrl":"https://vault.bitwarden.eu","lastSync":null,"status":"locked"}');
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.records.map((record) => record.argv[0])).toStrictEqual([
      '--version',
      'status',
      'serve',
    ]);
    await supervisor.stop();
  });

  it('VAULT-9 logs a failed initial sync and stays ready', async () => {
    const harness = new SupervisorHarness();
    harness.fake.override('POST', '/sync', 'not json');
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.messages()).toContain('initial vault sync failed');
    await supervisor.stop();
  });

  it('exposes a client bound to the running bw serve', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    const item = unwrapOk(await supervisor.client.getItem(FIXTURE_IDS.login));
    expect(item.name).toBe('Example login');
    await supervisor.stop();
    const status = unwrapOk(await supervisor.client.status());
    expect(status.state).toBe('unavailable');
  });
});

describe('startVaultSupervisor periodic sync', () => {
  it('VAULT-9 syncs every interval and a failure does not affect readiness', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.fake.requestsTo('/sync')).toHaveLength(1);

    await harness.clock.advance(60_000);
    await harness.until(() => harness.fake.requestsTo('/sync').length === 2);
    expect(harness.messages()).toContain('vault synced');

    harness.fake.override('POST', '/sync', { success: false, message: 'Server unreachable.' });
    await harness.clock.advance(60_000);
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(supervisor.isReady()).toBe(true);

    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
  });

  it('VAULT-9 does not reschedule a sync that finishes after shutdown', async () => {
    const fake = new FakeBwServe({ state: 'locked' });
    const gate = holdingSecondSync(fake);
    const harness = new SupervisorHarness({ fake, fetch: gate.fetch });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await harness.clock.advance(60_000);
    await harness.until(() => gate.syncsStarted() === 2);
    await supervisor.stop();
    gate.release();
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(supervisor.isReady()).toBe(false);
    expect(harness.clock.pending()).toBe(0);
  });
});

describe('resolveDependencies', () => {
  it('defaults to the real process, clock, network and port allocation', () => {
    expect(resolveDependencies({ environment: { PATH: '/usr/bin' } })).toStrictEqual({
      environment: { PATH: '/usr/bin' },
      spawn: spawnChild,
      clock: systemClock,
      fetch,
      allocatePort: allocateLoopbackPort,
    });
  });
});

describe('startVaultSupervisor stop', () => {
  it('VAULT-7 locks, terminates bw serve and disposes the credentials', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await supervisor.stop();
    expect(supervisor.isReady()).toBe(false);
    expect(harness.fake.requestsTo('/lock')).toHaveLength(1);
    expect(harness.fake.state).toBe('locked');
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    expect(harness.messages()).not.toContain('bw serve exited');
    expect(harness.clock.pending()).toBe(0);
  });

  it('VAULT-8 never runs bw logout', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await supervisor.stop();
    expect(harness.spawner.spawned('logout')).toStrictEqual([]);
  });

  it('VAULT-7 escalates to SIGKILL when bw serve ignores SIGTERM for five seconds', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('serve', ({ child }) => {
      child.ignore('SIGTERM');
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    const stopping = supervisor.stop();
    await harness.until(() => harness.serveChild().signals.length === 1);
    await harness.clock.advance(5000);
    await stopping;
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('backoffMs', () => {
  it('VAULT-6 doubles from one second and caps at one minute', () => {
    expect([1, 2, 3, 6, 7, 8, 20].map((attempt) => backoffMs(attempt))).toStrictEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect(backoffMs(0)).toBe(1000);
  });
});
