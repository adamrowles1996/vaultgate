import { describe, expect, it } from 'vitest';

import { CANARY } from '../test-support/fake-vault-fixture.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';
import { CLIENT_ID, harnessConfig, SupervisorHarness } from '../test-support/supervisor-harness.ts';

import { DEFAULT_SERVER_URL } from './requests.ts';

import type { FetchFunction } from './api.ts';

const NEXT = {
  clientId: 'user.next',
  clientSecret: 'CANARY-NEXT-CLIENT-SECRET',
  masterPassword: 'CANARY-NEXT-MASTER-PASSWORD',
  server: 'https://vault.next.test',
};
const UNCONFIGURED = {
  VAULTGATE_BW_CLIENT_ID: undefined,
  VAULTGATE_BW_CLIENT_SECRET: undefined,
  VAULTGATE_BW_PASSWORD: undefined,
};

function unconfiguredHarness(): SupervisorHarness {
  return new SupervisorHarness({ config: harnessConfig(UNCONFIGURED) });
}

function argvOf(harness: SupervisorHarness, from: number): (readonly string[])[] {
  return harness.spawner.records.slice(from).map((record) => record.argv);
}

describe('startVaultSupervisor unconfigured', () => {
  it('VAULT-18 boots without credentials, reports so, and runs nothing', async () => {
    const harness = unconfiguredHarness();
    const supervisor = harness.start();
    await harness.clock.settle();
    expect(supervisor.isReady()).toBe(false);
    expect(supervisor.source()).toStrictEqual({ origin: 'none', serverUrl: DEFAULT_SERVER_URL });
    expect(supervisor.credentials()).toBeUndefined();
    expect(harness.spawner.records).toStrictEqual([]);
    expect(unwrapOk(await supervisor.client.status()).state).toBe('unavailable');
    expect(harness.clock.pending()).toBe(0);
    await supervisor.stop();
    expect(harness.messages()).toStrictEqual([]);
  });
});

describe('VaultSupervisor.reconfigure', () => {
  it('VAULT-18 VAULT-8 switches to a fresh app-data generation and retires the old one', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    const before = supervisor.credentials();
    const spawnedBefore = harness.spawner.records.length;
    harness.fake.masterPassword = NEXT.masterPassword;

    unwrapOk(await supervisor.reconfigure(NEXT));

    expect(supervisor.isReady()).toBe(true);
    expect(supervisor.source()).toStrictEqual({ origin: 'settings', serverUrl: NEXT.server });
    expect(supervisor.credentials()?.clientId).toBe('user.next');
    expect(before?.disposed).toBe(true);
    expect(argvOf(harness, spawnedBefore)).toStrictEqual([
      ['--version'],
      ['status'],
      ['config', 'server', NEXT.server],
      ['login', '--apikey'],
      ['serve', '--hostname', '127.0.0.1', '--port', '43210'],
    ]);
    expect(harness.spawner.spawned('login')[1]?.environment).toMatchObject({
      BW_CLIENTID: 'user.next',
      BW_CLIENTSECRET: NEXT.clientSecret,
    });
    expect(harness.spawner.spawned('serve')[1]?.environment['BITWARDENCLI_APPDATA_DIR']).toBe(
      '/data/bw/2',
    );
    expect(harness.removed).toStrictEqual(['/data/bw/2', '/data/bw/1']);
    expect(harness.serveChild(0).signals).toStrictEqual(['SIGTERM']);
    expect(harness.fake.requestsTo('/lock')).toHaveLength(1);
    expect(harness.fake.requestsTo('/unlock')[1]?.body).toStrictEqual({
      password: NEXT.masterPassword,
    });
    expect(harness.spawner.spawned('logout')).toStrictEqual([]);
    const messages = harness.messages();
    expect(messages.indexOf('vault reconfigured')).toBeGreaterThan(
      messages.indexOf('vault locked'),
    );
    expect(harness.linesFor('vault reconfigured')[0]).toMatchObject({ server: NEXT.server });
    expect(unwrapOk(await supervisor.client.status()).state).toBe('unlocked');
    await supervisor.stop();
  });

  it('VAULT-6 keeps restarting the new generation after a later crash', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    unwrapOk(await supervisor.reconfigure({ ...NEXT, masterPassword: CANARY.masterPassword }));
    harness.serveChild(1).exit(1);
    await harness.until(() => !supervisor.isReady());
    harness.fake.state = 'locked';
    await harness.clock.advance(1000);
    await harness.until(() => supervisor.isReady());
    expect(harness.spawner.spawned('serve')).toHaveLength(3);
    expect(harness.spawner.spawned('serve')[2]?.environment['BITWARDENCLI_APPDATA_DIR']).toBe(
      '/data/bw/2',
    );
    expect(harness.removed).toStrictEqual(['/data/bw/2', '/data/bw/1']);
    await supervisor.stop();
  });

  it('VAULT-18 rolls back to the previous generation when the new login is rejected', async () => {
    const harness = new SupervisorHarness();
    harness.spawner.on('login', ({ child, environment }) => {
      const isNext = environment['BW_CLIENTID'] === NEXT.clientId;
      child.finish(isNext ? '' : 'You are logged in!\n', isNext ? 1 : 0);
    });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    const previous = supervisor.credentials();

    const error = unwrapFail(await supervisor.reconfigure(NEXT));

    expect(error.code).toBe('vault_unavailable');
    expect(error.message).toBe(
      'Bitwarden rejected the API key; check the client id and the client secret',
    );
    await harness.until(() => supervisor.isReady());
    expect(supervisor.source()).toStrictEqual({
      origin: 'environment',
      serverUrl: DEFAULT_SERVER_URL,
    });
    expect(supervisor.credentials()).toBe(previous);
    expect(previous?.disposed).toBe(false);
    expect(supervisor.credentials()?.clientId).toBe(CLIENT_ID);
    expect(harness.removed).toStrictEqual(['/data/bw/2', '/data/bw/2']);
    expect(harness.spawner.spawned('serve')).toHaveLength(2);
    expect(harness.spawner.spawned('serve')[1]?.environment['BITWARDENCLI_APPDATA_DIR']).toBe(
      '/data/bw/1',
    );
    expect(harness.messages()).toContain('vault reconfiguration failed');
    const everything = JSON.stringify(harness.logs.lines());
    expect(everything).not.toContain(NEXT.clientSecret);
    expect(everything).not.toContain(NEXT.masterPassword);
    await supervisor.stop();
  });

  it('VAULT-18 rolls back to unconfigured when the very first connection is refused', async () => {
    const harness = unconfiguredHarness();
    const supervisor = harness.start();
    await harness.clock.settle();

    const error = unwrapFail(await supervisor.reconfigure(NEXT));

    expect(error.message).toBe('the vault rejected the master password');
    expect(supervisor.isReady()).toBe(false);
    expect(supervisor.source().origin).toBe('none');
    expect(supervisor.credentials()).toBeUndefined();
    expect(harness.serveChild(0).signals).toStrictEqual(['SIGTERM']);
    expect(harness.removed).toStrictEqual(['/data/bw/1', '/data/bw/1']);
    expect(harness.clock.pending()).toBe(0);
    await supervisor.stop();
    expect(harness.fake.requestsTo('/lock')).toStrictEqual([]);
  });

  it('VAULT-18 refuses a second reconfiguration while one is in flight', async () => {
    const harness = unconfiguredHarness();
    harness.fake.masterPassword = NEXT.masterPassword;
    const supervisor = harness.start();
    const first = supervisor.reconfigure(NEXT);
    const second = unwrapFail(await supervisor.reconfigure(NEXT));
    expect(second.message).toBe('the vault backend is busy switching connections');
    unwrapOk(await first);
    expect(supervisor.isReady()).toBe(true);
    await supervisor.stop();
  });

  it('VAULT-18 refuses to reconfigure once shutting down', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await supervisor.stop();
    const error = unwrapFail(await supervisor.reconfigure(NEXT));
    expect(error.message).toBe('the vault backend is shutting down');
    expect(harness.spawner.spawned('serve')).toHaveLength(1);
  });

  it('VAULT-7 a stop while the new child is still settling leaves nothing running', async () => {
    const harness = unconfiguredHarness();
    harness.fake.override('GET', '/status', 'not the envelope');
    const supervisor = harness.start();
    const switching = supervisor.reconfigure(NEXT);
    await harness.until(() => harness.spawner.spawned('serve').length === 1);
    await supervisor.stop();
    const error = unwrapFail(await switching);
    expect(error.message).toBe('bw serve did not start in time');
    expect(harness.serveChild(0).signals).toStrictEqual(['SIGTERM']);
    expect(supervisor.isReady()).toBe(false);
    expect(harness.removed).toStrictEqual(['/data/bw/1', '/data/bw/1']);
    expect(harness.clock.pending()).toBe(0);
    expect(harness.messages()).toContain('vault reconfiguration failed');
  });

  it('VAULT-7 a stop that lands as the new child becomes ready tears it down again', async () => {
    let releaseSync: (() => void) | undefined;
    const fake = unconfiguredHarness().fake;
    fake.masterPassword = NEXT.masterPassword;
    const fetchWithGate: FetchFunction = async (input, init) => {
      if (input.endsWith('/sync')) {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        releaseSync = () => {
          resolve(undefined);
        };
        await promise;
      }
      return fake.fetch(input, init);
    };
    const harness = new SupervisorHarness({
      config: harnessConfig(UNCONFIGURED),
      fake,
      fetch: fetchWithGate,
    });
    const supervisor = harness.start();
    const switching = supervisor.reconfigure(NEXT);
    await harness.until(() => releaseSync !== undefined);
    const stopping = supervisor.stop();
    releaseSync?.();
    await stopping;
    const error = unwrapFail(await switching);
    expect(error.message).toBe('the vault backend could not start; the server log has the reason');
    expect(harness.linesFor('vault reconfiguration failed')[0]).toMatchObject({
      err: { message: 'stopped while reconfiguring' },
    });
    expect(harness.serveChild(0).signals).toStrictEqual(['SIGTERM']);
    expect(supervisor.isReady()).toBe(false);
    expect(supervisor.credentials()).toBeUndefined();
    expect(harness.removed).toStrictEqual(['/data/bw/1', '/data/bw/1']);
  });
});
