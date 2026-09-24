import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { spawnChild, VersionRefusedError } from './serve-process.ts';
import {
  backoffMs,
  describeStartFailure,
  removeDirectoryFromDisk,
  resolveDependencies,
} from './supervisor-support.ts';

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
      BITWARDENCLI_APPDATA_DIR: '/data/bw/1',
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

  it('VAULT-3 resets a reused app-data directory to the default server before login', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('status', ({ child }) => {
      child.finish(
        '{"serverUrl":"https://old.example","lastSync":null,"status":"unauthenticated"}',
      );
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.records.map((record) => record.argv).slice(1, 4)).toStrictEqual([
      ['status'],
      ['config', 'server', 'bitwarden.com'],
      ['login', '--apikey'],
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

describe('resolveDependencies', () => {
  it('defaults to the real process, clock, network, port allocation and filesystem', () => {
    expect(resolveDependencies({ environment: { PATH: '/usr/bin' } })).toStrictEqual({
      environment: { PATH: '/usr/bin' },
      stored: { kind: 'none' },
      spawn: spawnChild,
      clock: systemClock,
      fetch,
      allocatePort: allocateLoopbackPort,
      removeDirectory: removeDirectoryFromDisk,
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
    const messages = harness.messages();
    expect(messages.indexOf('vault locked')).toBeGreaterThan(messages.indexOf('vault ready'));
    expect(messages.indexOf('bw serve stopped')).toBeGreaterThan(messages.indexOf('vault locked'));
    expect(harness.linesFor('vault locked')[0]).toMatchObject({ level: 30 });
    expect(harness.linesFor('bw serve stopped')[0]).toMatchObject({ level: 30 });
  });

  it('VAULT-7 logs a refused lock and still stops bw serve', async () => {
    const harness = new SupervisorHarness();
    harness.fake.override('POST', '/lock', { success: false, message: 'Vault is busy.' });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await supervisor.stop();
    expect(harness.messages()).not.toContain('vault locked');
    expect(harness.linesFor('vault lock failed')[0]).toMatchObject({ level: 40 });
    expect(harness.messages()).toContain('bw serve stopped');
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
  });

  it('VAULT-7 a backend that has already stopped is not a lock failure, so a clean shutdown logs no warning', async () => {
    const fake = new FakeBwServe({ state: 'locked' });
    // What a real shutdown does: the child is gone before the lock lands, so
    // the call cannot connect and fails `vault_unavailable`. Its session went
    // with it, which is the outcome the lock was for.
    const harness = new SupervisorHarness({
      fake,
      fetch: (input, init) =>
        input.endsWith('/lock')
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : fake.fetch(input, init),
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await supervisor.stop();
    expect(harness.messages()).toContain('vault backend already stopped; its session went with it');
    expect(harness.linesFor('vault lock failed')).toStrictEqual([]);
    expect(harness.logs.lines().filter((line) => Number(line['level']) >= 40)).toStrictEqual([]);
    expect(harness.messages()).toContain('bw serve stopped');
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

describe('removeDirectoryFromDisk', () => {
  it('VAULT-8 deletes a retired app-data generation and tolerates one that is already gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vaultgate-appdata-'));
    const generation = join(root, '1');
    mkdirSync(generation);
    writeFileSync(join(generation, 'data.json'), '{}');
    await removeDirectoryFromDisk(generation);
    await removeDirectoryFromDisk(generation);
    expect(existsSync(generation)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('describeStartFailure', () => {
  it('VAULT-18 VAULT-14 names the cause without repeating what the CLI said', () => {
    const cases: [Error, string][] = [
      [
        new VersionRefusedError('bw 1.0.0 is older than the minimum 2025.1.0'),
        'bw 1.0.0 is older than the minimum 2025.1.0',
      ],
      [
        new Error('bw login exited with status 1'),
        'Bitwarden rejected the API key; check the client id and the client secret',
      ],
      [new Error('bw config exited with status 1'), 'the Bitwarden CLI rejected the server URL'],
      [
        new Error('bw status exited with status 1'),
        'the Bitwarden CLI could not report its status',
      ],
      [
        new Error('the vault rejected the master password'),
        'the vault rejected the master password',
      ],
      [new Error('bw serve did not answer /status in time'), 'bw serve did not start in time'],
      [
        new Error('spawn /opt/bw ENOENT'),
        'the vault backend could not start; the server log has the reason',
      ],
    ];
    expect(cases.map(([error]) => describeStartFailure(error))).toStrictEqual(
      cases.map(([, text]) => text),
    );
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
