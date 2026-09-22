import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { CANARY } from '../test-support/fake-vault-fixture.ts';
import { harnessConfig, SupervisorHarness } from '../test-support/supervisor-harness.ts';

const WARN = 40;
const ERROR = 50;
const FAILED = 'vault backend start failed';
const UNAVAILABLE = 'vault backend unavailable';

function failures(harness: SupervisorHarness): Record<string, unknown>[] {
  return harness.logs
    .lines()
    .filter((line) => line['msg'] === FAILED || line['msg'] === UNAVAILABLE);
}

describe('startVaultSupervisor restarts', () => {
  it('VAULT-6 restarts bw serve with backoff after it exits and re-unlocks', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());

    harness.serveChild(0).exit(1);
    await harness.until(() => !supervisor.isReady());
    expect(harness.linesFor('bw serve exited')[0]).toMatchObject({ code: 1, signal: null });
    await harness.until(() => failures(harness).length === 1);
    expect(failures(harness)[0]).toMatchObject({ level: WARN, attempt: 1, nextRetryMs: 1000 });
    expect(harness.spawner.spawned('serve')).toHaveLength(1);

    harness.fake.state = 'locked';
    await harness.clock.advance(1000);
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.spawned('serve')).toHaveLength(2);
    expect(harness.fake.requestsTo('/unlock')).toHaveLength(2);

    harness.serveChild(1).exit(0);
    await harness.until(() => failures(harness).length === 2);
    expect(failures(harness)[1]).toMatchObject({ attempt: 1, nextRetryMs: 1000 });
    await supervisor.stop();
  });

  it('VAULT-5 VAULT-6 keeps retrying a missing binary, escalating to error after ten failures', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('--version', ({ child }) => {
      child.fail(new Error('spawn bw ENOENT'));
    });
    const supervisor = harness.start();
    const delays: number[] = [];
    const levels: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await harness.until(() => failures(harness).length === attempt);
      const line = failures(harness)[attempt - 1]!;
      delays.push(Number(line['nextRetryMs']));
      levels.push(Number(line['level']));
      expect(supervisor.isReady()).toBe(false);
      await harness.clock.advance(Number(line['nextRetryMs']));
    }
    expect(delays).toStrictEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(levels).toStrictEqual([
      WARN,
      WARN,
      WARN,
      WARN,
      WARN,
      WARN,
      WARN,
      WARN,
      WARN,
      ERROR,
      ERROR,
      ERROR,
    ]);
    expect(harness.spawner.spawned('serve')).toStrictEqual([]);
    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
  });

  it('VAULT-2 refuses an old CLI once and stops retrying', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('--version', ({ child }) => {
      child.finish('2024.12.0\n');
    });
    const supervisor = harness.start();
    await harness.until(() => harness.messages().includes('bitwarden cli refused'));
    expect(harness.linesFor('bitwarden cli refused')[0]).toMatchObject({ level: ERROR });
    expect(harness.spawner.records).toHaveLength(1);
    expect(harness.clock.pending()).toBe(0);
    expect(supervisor.isReady()).toBe(false);
    await supervisor.stop();
  });
});

describe('startVaultSupervisor start-up failures', () => {
  it('stops the child and retries when the master password is rejected', async () => {
    const harness = new SupervisorHarness({ fake: new FakeBwServe({ masterPassword: 'other' }) });
    const supervisor = harness.start();
    await harness.until(() => failures(harness).length === 1);
    expect(failures(harness)[0]).toMatchObject({
      err: { message: 'the vault rejected the master password' },
    });
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    expect(JSON.stringify(failures(harness))).not.toContain(CANARY.masterPassword);
    await supervisor.stop();
  });

  it('gives up on a bw serve that never answers /status and stops it', async () => {
    const harness = new SupervisorHarness({
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const supervisor = harness.start();
    await harness.until(() => harness.spawner.spawned('serve').length === 1);
    for (let elapsed = 0; elapsed < 30_000; elapsed += 250) {
      await harness.clock.advance(250);
    }
    await harness.until(() => failures(harness).length === 1);
    expect(failures(harness)[0]).toMatchObject({
      err: { message: 'bw serve did not answer /status in time' },
    });
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    await supervisor.stop();
  });

  it('records a failing bw status, config server or login and retries', async () => {
    const cases = [
      { command: 'status', message: 'bw status exited with status 1', server: undefined },
      { command: 'config', message: 'bw config exited with status 1', server: 'bitwarden.eu' },
      { command: 'login', message: 'bw login exited with status 1', server: undefined },
    ];
    for (const { command, message, server } of cases) {
      const harness = new SupervisorHarness({
        config: harnessConfig(server === undefined ? {} : { VAULTGATE_BW_SERVER: server }),
      });
      harness.spawner.on(command, ({ child }) => {
        child.finish('', 1);
      });
      const supervisor = harness.start();
      await harness.until(() => failures(harness).length === 1);
      expect(failures(harness)[0]).toMatchObject({ err: { message } });
      expect(harness.spawner.spawned('serve')).toStrictEqual([]);
      await supervisor.stop();
    }
  });
});

describe('startVaultSupervisor stop during start-up', () => {
  it('ends the loop promptly when stopped during a backoff', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('--version', ({ child }) => {
      child.fail(new Error('spawn bw ENOENT'));
    });
    const supervisor = harness.start();
    await harness.until(() => failures(harness).length === 1);
    expect(harness.clock.pending()).toBe(1);
    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
    expect(harness.spawner.records).toHaveLength(1);
  });

  it('stops polling /status and records nothing when stopped while bw serve starts', async () => {
    const harness = new SupervisorHarness({
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const supervisor = harness.start();
    await harness.until(() => harness.spawner.spawned('serve').length === 1);
    await supervisor.stop();
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    expect(failures(harness)).toStrictEqual([]);
    expect(harness.clock.pending()).toBe(0);
  });
});
