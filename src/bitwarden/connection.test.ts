import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../test-support/database.ts';
import { CANARY } from '../test-support/fake-vault-fixture.ts';
import { sequentialRandom } from '../test-support/identity.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';
import {
  CLIENT_SECRET,
  harnessConfig,
  SupervisorHarness,
} from '../test-support/supervisor-harness.ts';

import { createVaultConnection } from './connection.ts';
import { DEFAULT_SERVER_URL } from './requests.ts';
import { createVaultSettings, type StoredVaultSettings, type VaultSettings } from './settings.ts';

import type { VaultConnection } from '../vault/connection.ts';

const OPERATOR = 'operator-1';
const NOW = Date.UTC(2026, 8, 22, 12, 30, 0);
const UNCONFIGURED = {
  VAULTGATE_BW_CLIENT_ID: undefined,
  VAULTGATE_BW_CLIENT_SECRET: undefined,
  VAULTGATE_BW_PASSWORD: undefined,
};
const STORED: StoredVaultSettings = {
  kind: 'ok',
  updatedAt: 0,
  values: {
    clientId: 'user.stored',
    clientSecret: 'stored-secret',
    masterPassword: CANARY.masterPassword,
    server: 'bitwarden.eu',
  },
};
const KEEP = {
  serverUrl: undefined,
  clientId: 'user.next',
  clientSecret: undefined,
  masterPassword: undefined,
};

interface Wired {
  readonly harness: SupervisorHarness;
  readonly connection: VaultConnection;
  readonly settings: VaultSettings;
  readonly supervisor: ReturnType<SupervisorHarness['start']>;
}

function wire(harness: SupervisorHarness): Wired {
  const database = openTestDatabase();
  const settings = createVaultSettings({
    database,
    secretKey: harness.config.secrets.secretKey,
    random: sequentialRandom(),
  });
  if (harness.stored.kind === 'ok') {
    settings.save(harness.stored.values, 'installer', 0);
  }
  const supervisor = harness.start();
  const connection = createVaultConnection({ supervisor, settings, clock: () => NOW });
  return { harness, connection, settings, supervisor };
}

describe('createVaultConnection status', () => {
  it('ID-25 reports an unconfigured backend', async () => {
    const { harness, connection, supervisor } = wire(
      new SupervisorHarness({ config: harnessConfig(UNCONFIGURED) }),
    );
    await harness.clock.settle();
    expect(await connection.status()).toStrictEqual({
      configured: false,
      origin: 'none',
      serverUrl: DEFAULT_SERVER_URL,
      ready: false,
      userEmailMasked: null,
      lastSyncAt: null,
    });
    await supervisor.stop();
  });

  it('ID-25 reports the ready backend with the live server and masked account', async () => {
    const { harness, connection, supervisor } = wire(new SupervisorHarness());
    await harness.until(() => supervisor.isReady());
    expect(await connection.status()).toStrictEqual({
      configured: true,
      origin: 'environment',
      serverUrl: 'https://vault.example.test',
      ready: true,
      userEmailMasked: 'a***@example.com',
      lastSyncAt: '2026-09-22T12:00:00.000Z',
    });
    await supervisor.stop();
  });

  it('ID-25 falls back to the configured server when bw serve answers oddly', async () => {
    const { harness, connection, supervisor } = wire(new SupervisorHarness({ stored: STORED }));
    await harness.until(() => supervisor.isReady());
    harness.fake.override('GET', '/status', 'garbage');
    expect(await connection.status()).toMatchObject({
      origin: 'settings',
      serverUrl: 'bitwarden.eu',
      ready: true,
      userEmailMasked: null,
    });
    await supervisor.stop();
  });
});

describe('createVaultConnection configure', () => {
  it('ID-25 saves the row, switches, and keeps blank secrets from the running connection', async () => {
    const { harness, connection, settings, supervisor } = wire(new SupervisorHarness());
    await harness.until(() => supervisor.isReady());
    unwrapOk(await connection.configure(KEEP, OPERATOR));
    expect(settings.load()).toStrictEqual({
      kind: 'ok',
      updatedAt: NOW,
      values: {
        clientId: 'user.next',
        clientSecret: CLIENT_SECRET,
        masterPassword: CANARY.masterPassword,
        server: undefined,
      },
    });
    expect(supervisor.source().origin).toBe('settings');
    expect(harness.spawner.spawned('login')[1]?.environment['BW_CLIENTID']).toBe('user.next');
    await supervisor.stop();
  });

  it('ID-25 refuses blank secrets while nothing is running, touching neither store nor backend', async () => {
    const { harness, connection, settings, supervisor } = wire(
      new SupervisorHarness({ config: harnessConfig(UNCONFIGURED) }),
    );
    const error = unwrapFail(await connection.configure(KEEP, OPERATOR));
    expect(error.code).toBe('vault_unavailable');
    expect(error.message).toBe(
      'no vault connection is configured yet: enter both the client secret and the master password',
    );
    expect(settings.load()).toStrictEqual({ kind: 'none' });
    expect(harness.spawner.records).toStrictEqual([]);
    await supervisor.stop();
  });

  it('ID-25 restores the previous row when the switch fails', async () => {
    const harness = new SupervisorHarness({ stored: STORED });
    harness.spawner.on('login', ({ child, environment }) => {
      const isBad = environment['BW_CLIENTID'] === 'user.bad';
      child.finish(isBad ? '' : 'You are logged in!\n', isBad ? 1 : 0);
    });
    const { connection, settings, supervisor } = wire(harness);
    await harness.until(() => supervisor.isReady());
    const error = unwrapFail(
      await connection.configure({ ...KEEP, clientId: 'user.bad' }, OPERATOR),
    );
    expect(error.message).toMatch(/rejected the API key/);
    expect(settings.load()).toStrictEqual({ kind: 'ok', updatedAt: 0, values: STORED.values });
    await harness.until(() => supervisor.isReady());
    expect(supervisor.credentials()?.clientId).toBe('user.stored');
    await supervisor.stop();
  });

  it('ID-25 removes the row again when the first connection ever fails', async () => {
    const { harness, connection, settings, supervisor } = wire(
      new SupervisorHarness({ config: harnessConfig(UNCONFIGURED) }),
    );
    const input = { ...KEEP, clientSecret: 'secret', masterPassword: 'wrong' };
    const error = unwrapFail(await connection.configure(input, OPERATOR));
    expect(error.message).toBe('the vault rejected the master password');
    expect(settings.load()).toStrictEqual({ kind: 'none' });
    expect(harness.spawner.spawned('serve')).toHaveLength(1);
    await supervisor.stop();
  });
});
