import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_VAULT } from '../test-support/fake-vault-connection.ts';
import {
  compact,
  createHarness,
  csrfOf,
  type Harness,
  makeLegacy,
  pageText,
  setUpOperator,
} from '../test-support/identity-app.ts';
import { VaultError } from '../vault/client.ts';

import type { Browser } from '../test-support/browser.ts';

const SYNC_FORM = '<form method="post" action="/account/vault/sync">';

interface ReadyVault {
  readonly harness: Harness;
  readonly browser: Browser;
  readonly csrf: string;
}

async function readyVault(): Promise<ReadyVault> {
  const harness = createHarness();
  harness.vault.current = ENVIRONMENT_VAULT;
  const { browser } = await setUpOperator(harness);
  return { harness, browser, csrf: csrfOf(await pageText(browser, '/account/vault')) };
}

function syncAudits(harness: Harness) {
  return harness.audits.filter((event) => event.action === 'vault.sync_requested');
}

describe('POST /account/vault/sync', () => {
  it('VAULT-19 ID-25 offers Sync now while the vault is ready, with no password confirmation', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    expect(await pageText(browser, '/account/vault')).not.toContain(SYNC_FORM);
    harness.vault.current = { ...ENVIRONMENT_VAULT, ready: false };
    expect(await pageText(browser, '/account/vault')).not.toContain(SYNC_FORM);
    harness.vault.current = ENVIRONMENT_VAULT;
    const markup = compact(await pageText(browser, '/account/vault'));
    expect(markup).toContain(`<div class="page-actions">${SYNC_FORM}`);
    expect(markup).toContain('</svg> Sync now</button>');
  });

  it('VAULT-19 ID-25 syncs on request and comes back with the new last sync, recording who asked', async () => {
    const { harness, browser, csrf } = await readyVault();
    const response = await browser.submit('/account/vault/sync', { csrf });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/vault?notice=vault-synced');
    expect(harness.vault.syncs).toBe(1);
    const markup = compact(await pageText(browser, '/account/vault?notice=vault-synced'));
    expect(markup).toContain('<p class="notice">The vault synced with the server.</p>');
    expect(markup).toContain('>2026-09-22 12:30 UTC<');
    const operatorId = harness.stores.operators.findAny()?.id;
    expect(syncAudits(harness)).toStrictEqual([
      expect.objectContaining({ category: 'identity', outcome: 'ok', operatorId }),
    ]);
    expect(syncAudits(harness)[0]).not.toHaveProperty('details');
  });

  it('VAULT-19 ID-25 shows the fixed reason when the sync fails, and records it', async () => {
    const { harness, browser, csrf } = await readyVault();
    harness.vault.syncError = new VaultError(
      'vault_unavailable',
      'the vault is locked or not reachable',
    );
    const response = await browser.submit('/account/vault/sync', { csrf });
    expect(response.status).toBe(503);
    const markup = compact(await response.text());
    expect(markup).toContain('The vault did not sync: the vault is locked or not reachable.');
    expect(markup).toContain('<title>Vault · vaultgate</title>');
    expect(syncAudits(harness)).toStrictEqual([
      expect.objectContaining({ outcome: 'failure', details: { reason: 'vault_unavailable' } }),
    ]);
  });

  it('ID-18 ID-26 refuses a cross-site or stale-token sync, and one from an account with no address yet', async () => {
    const { harness, browser, csrf } = await readyVault();
    const crossSite = await browser.submit('/account/vault/sync', { csrf }, { origin: false });
    expect(crossSite.status).toBe(403);
    const staleToken = await browser.submit('/account/vault/sync', { csrf: 'stale' });
    expect(staleToken.status).toBe(403);
    makeLegacy(harness);
    const legacy = await browser.submit('/account/vault/sync', { csrf });
    expect(legacy.status).toBe(403);
    expect(harness.vault.syncs).toBe(0);
    expect(syncAudits(harness)).toStrictEqual([]);
  });
});
