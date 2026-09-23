/**
 * Drives the real Bitwarden CLI against a real account (spec §05, PLAN M5).
 * Runs through `npm run test:integration`; the environment it needs is read
 * in one place, `src/test-support/integration-environment.ts`, and without it
 * the suite skips with that reason. The vault is read, never written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/index.ts';
import { createLogger } from '../logger.ts';
import {
  type IntegrationEnvironment,
  readIntegrationEnvironment,
} from '../test-support/integration-environment.ts';
import { unwrapOk } from '../test-support/result.ts';

import { CALL_TIMEOUT_MS } from './api.ts';
import { systemClock } from './clock.ts';
import { startVaultSupervisor } from './index.ts';
import { BwCli, spawnChild } from './serve-process.ts';

import type { VaultSupervisor } from './supervisor.ts';

/**
 * How long `beforeAll` waits for readiness. A first attempt can spend
 * `CALL_TIMEOUT_MS` on `/unlock` alone (VAULT-16) before the restart loop
 * stops the child and starts the same generation again a second later
 * (VAULT-6), and each one-shot CLI command costs a few seconds, so the
 * deadline covers one such failed attempt and a clean second one. The
 * integration project's `hookTimeout` in `vitest.config.ts` sits above it.
 */
const READY_TIMEOUT_MS = 2 * CALL_TIMEOUT_MS + 30_000;
const POLL_MS = 500;

const configured = readIntegrationEnvironment();

interface Running {
  readonly integration: IntegrationEnvironment;
  readonly dataDirectory: string;
  readonly environment: { readonly PATH: string | undefined; readonly HOME: string | undefined };
  readonly supervisor: VaultSupervisor;
}

function start(integration: IntegrationEnvironment): Running {
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
  // `info` so a run shows when the CLI logged in, synced and became ready;
  // none of those lines carries a secret (VAULT-14, VAULT-15).
  const supervisor = startVaultSupervisor(config, createLogger('info'), { environment });
  return { integration, dataDirectory, environment, supervisor };
}

/**
Polls `isReady()` on the real clock; the hook fails with the reason rather than letting the first test find `false`.
*/
async function untilReady(supervisor: VaultSupervisor): Promise<void> {
  const startedAt = Date.now();
  while (!supervisor.isReady()) {
    if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
      throw new Error(
        `the vault backend was not ready within ${READY_TIMEOUT_MS} ms; ` +
          'each failed start is a "vault backend start failed" line above',
      );
    }
    await wait(POLL_MS);
  }
}

// A conditional skip, not a disabled test (vitest/no-disabled-tests matches
// `.skip` only): the suite runs whenever the credentials are present. The
// title says why it is skipped otherwise.
describe.skipIf(configured === undefined)(
  'bw serve backend against a real vault (skipped without VAULTGATE_TEST_BW_* credentials)',
  () => {
    let running: Running;
    let supervisor: VaultSupervisor;
    let integration: IntegrationEnvironment;

    beforeAll(async () => {
      if (configured === undefined) {
        throw new Error('the integration suite ran without its credentials');
      }
      running = start(configured);
      ({ supervisor, integration } = running);
      await untilReady(supervisor);
    });

    afterAll(async () => {
      await supervisor.stop();
      rmSync(running.dataDirectory, { recursive: true, force: true });
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
        appDataDirectory: join(running.dataDirectory, 'bw', '1'),
        environment: running.environment,
        spawn: spawnChild,
        clock: systemClock,
      });
      expect(unwrapOk(await cli.status()).status).toBe('locked');
    });
  },
);
