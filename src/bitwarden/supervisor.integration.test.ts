/**
 * Drives the real Bitwarden CLI against a real account (spec §05, PLAN M5).
 * Runs only through `npm run test:integration`; the environment it needs is
 * read in one place, `src/test-support/integration-environment.ts`.
 * The vault is read, never written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/index.ts';
import { createLogger } from '../logger.ts';
import { readIntegrationEnvironment } from '../test-support/integration-environment.ts';
import { unwrapOk } from '../test-support/result.ts';

import { systemClock } from './clock.ts';
import { startVaultSupervisor, type VaultSupervisor } from './index.ts';
import { BwCli, spawnChild } from './serve-process.ts';

const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

const integration = readIntegrationEnvironment();
const dataDirectory = mkdtempSync(join(tmpdir(), 'vaultgate-integration-'));
const config = unwrapOk(
  loadConfig({
    VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
    VAULTGATE_SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
    VAULTGATE_DATA_DIR: dataDirectory,
    VAULTGATE_BW_BIN: integration.bin,
    VAULTGATE_BW_SERVER: integration.server,
    VAULTGATE_BW_CLIENT_ID: integration.clientId,
    VAULTGATE_BW_CLIENT_SECRET: integration.clientSecret,
    VAULTGATE_BW_PASSWORD: integration.masterPassword,
  }),
).config;
const environment = { PATH: integration.path, HOME: integration.home };
const supervisor: VaultSupervisor = startVaultSupervisor(config, createLogger('warn'), {
  environment,
});

async function untilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!supervisor.isReady() && Date.now() < deadline) {
    await wait(POLL_MS);
  }
}

describe('bw serve backend against a real vault', () => {
  beforeAll(async () => {
    await untilReady();
  });

  afterAll(async () => {
    await supervisor.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('VAULT-4 VAULT-5 logs in, unlocks and becomes ready', async () => {
    expect(supervisor.isReady()).toBe(true);
    const status = unwrapOk(await supervisor.client.status());
    expect(status.state).toBe('unlocked');
    expect(status.lastSyncAt).not.toBeNull();
    expect(status.userEmailMasked).toMatch(/^.\*\*\*@/);
  });

  it('VAULT-9 syncs on demand', async () => {
    expect(await supervisor.client.sync()).toStrictEqual({ ok: true, value: undefined });
  });

  it('VAULT-12 VAULT-13 reads folders, collections and item summaries through the schemas', async () => {
    unwrapOk(await supervisor.client.listFolders());
    unwrapOk(await supervisor.client.listCollections());
    const items = unwrapOk(await supervisor.client.searchItems({ limit: 5 }));
    expect(items.length).toBeLessThanOrEqual(5);
    for (const item of items) {
      expect(unwrapOk(await supervisor.client.getItem(item.id)).id).toBe(item.id);
    }
  });

  it('generates a password without storing anything', async () => {
    const password = unwrapOk(
      await supervisor.client.generatePassword({
        length: 20,
        uppercase: true,
        lowercase: true,
        numbers: true,
        special: false,
      }),
    );
    expect(password).toHaveLength(20);
  });

  it('VAULT-7 VAULT-8 locks and stops bw serve on stop but stays logged in', async () => {
    await supervisor.stop();
    expect(supervisor.isReady()).toBe(false);
    expect(unwrapOk(await supervisor.client.status()).state).toBe('unavailable');
    const cli = new BwCli({
      bin: integration.bin,
      appDataDirectory: join(dataDirectory, 'bw', '1'),
      environment,
      spawn: spawnChild,
      clock: systemClock,
    });
    expect(unwrapOk(await cli.status()).status).toBe('locked');
  });
});
