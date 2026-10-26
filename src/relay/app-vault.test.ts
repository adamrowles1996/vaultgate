import { describe, expect, it, vi } from 'vitest';

import { fail, ok } from '../result.ts';
import { InMemoryVaultClient } from '../test-support/in-memory-vault-client.ts';
import {
  relayGet,
  relayHarness,
  RELAY_ID,
  RELAY_SECRET,
  type RelayHarness,
  summary,
} from '../test-support/relay-fixtures.ts';
import {
  type SecretField,
  type SecretValue,
  VaultError,
  type VaultLockState,
  type VaultResult,
  type VaultStatus,
} from '../vault/client.ts';

import { MAX_LIST_ITEMS } from './handlers.ts';

const UNAVAILABLE = new VaultError('vault_unavailable', 'locked');
const PROTOCOL = new VaultError('vault_protocol_error', 'odd');

async function json(response: Response): Promise<unknown> {
  return response.json();
}

function withStatus(harness: RelayHarness, state: VaultLockState): void {
  const status: VaultStatus = {
    serverUrl: 'https://vault.example.com',
    userEmailMasked: 'o***@example.com',
    state,
    lastSyncAt: '2026-10-14T11:00:00.000Z',
  };
  vi.spyOn(harness.vault, 'status').mockResolvedValue(ok(status));
}

describe('relay status', () => {
  it('RELAY-10 reports the lock state and nothing about the server or account', async () => {
    const harness = relayHarness();
    for (const state of ['unlocked', 'locked', 'unauthenticated'] as const) {
      withStatus(harness, state);
      const response = await relayGet(harness, '/status');
      expect(await json(response)).toStrictEqual({
        success: true,
        data: {
          object: 'template',
          template: {
            serverUrl: null,
            lastSync: '2026-10-14T11:00:00.000Z',
            userEmail: null,
            status: state,
          },
        },
      });
    }
  });

  it('RELAY-10 answers 503 while the vault is unavailable, and on a failed status', async () => {
    const harness = relayHarness();
    withStatus(harness, 'unavailable');
    const unavailable = await relayGet(harness, '/status');
    expect(unavailable.status).toBe(503);
    expect(await json(unavailable)).toStrictEqual({
      success: false,
      message: 'Vault is unavailable.',
    });
    vi.spyOn(harness.vault, 'status').mockResolvedValue(fail(PROTOCOL));
    const broken = await relayGet(harness, '/status');
    expect(broken.status).toBe(500);
    expect(harness.audit.events.at(-1)?.outcome).toBe('error:vault_protocol_error');
  });
});

describe('relay list route', () => {
  it('RELAY-6 lists the in-scope matches of a search, each one audited', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, '/list/object/items?search=database');
    const body = (await json(response)) as { data: { object: string; data: { id: string }[] } };
    expect(body.data.object).toBe('list');
    expect(body.data.data.map((item) => item.id)).toStrictEqual([RELAY_ID.database]);
    expect(harness.audit.events.map((event) => [event.action, event.itemId])).toStrictEqual([
      ['relay.list', RELAY_ID.database],
    ]);
  });

  it('RELAY-6 answers an empty list when nothing in scope matches', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, '/list/object/items?search=payroll');
    expect(await json(response)).toStrictEqual({
      success: true,
      data: { object: 'list', data: [] },
    });
    expect(harness.audit.events.at(-1)?.details).toStrictEqual({
      node: 'sandbox-1.example.ts.net',
      results: 0,
      term: 'payroll',
    });
  });

  it('RELAY-6 requires a search term and refuses one longer than 200 characters', async () => {
    const harness = relayHarness();
    for (const query of ['', '?search=', '?search=%20%20', `?search=${'b'.repeat(201)}`]) {
      const response = await relayGet(harness, `/list/object/items${query}`);
      expect(response.status).toBe(400);
    }
  });

  it('RELAY-6 refuses a search matching more than 20 in-scope items', async () => {
    const many = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, index) => ({
      summary: summary(`1a2b3c4d-0000-4000-8000-${String(index).padStart(12, '0')}`, 'Bulk'),
      secrets: { password: `bulk-${String(index)}` },
    }));
    const harness = relayHarness();
    const bulk = new InMemoryVaultClient(many);
    vi.spyOn(harness.vault, 'searchItems').mockImplementation(async (query) =>
      bulk.searchItems(query),
    );
    const response = await relayGet(harness, '/list/object/items?search=Bulk');
    expect(response.status).toBe(400);
    expect(await json(response)).toStrictEqual({
      success: false,
      message: 'Too many results; search more narrowly.',
    });
  });
});

function failingSecret(harness: RelayHarness, kind: SecretField['kind']): void {
  const original = harness.vault.getSecret.bind(harness.vault);
  vi.spyOn(harness.vault, 'getSecret').mockImplementation(
    async (id: string, field: SecretField): VaultResult<SecretValue> =>
      field.kind === kind ? fail(UNAVAILABLE) : original(id, field),
  );
}

describe('relay vault failures', () => {
  it('RELAY-10 answers 503 when the vault is unavailable for a lookup', async () => {
    const harness = relayHarness();
    harness.vault.failWith(UNAVAILABLE);
    for (const path of [
      `/object/item/${RELAY_ID.database}`,
      '/object/password/Mailer',
      '/list/object/items?search=database',
    ]) {
      const response = await relayGet(harness, path);
      expect(response.status).toBe(503);
    }
    expect(harness.audit.events.map((event) => event.outcome)).toStrictEqual([
      'error:vault_unavailable',
      'error:vault_unavailable',
      'error:vault_unavailable',
    ]);
  });

  it('RELAY-10 answers 500 for any other vault failure', async () => {
    const harness = relayHarness();
    harness.vault.failWith(PROTOCOL);
    const response = await relayGet(harness, `/object/item/${RELAY_ID.database}`);
    expect(response.status).toBe(500);
    expect(await json(response)).toStrictEqual({ success: false, message: 'Vault error.' });
  });

  it('RELAY-10 fails the whole answer when a secret cannot be read', async () => {
    for (const kind of ['password', 'notes', 'customField', 'totp'] as const) {
      const harness = relayHarness();
      failingSecret(harness, kind);
      const path =
        kind === 'totp' ? `/object/totp/${RELAY_ID.database}` : `/object/item/${RELAY_ID.database}`;
      const response = await relayGet(harness, path);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(RELAY_SECRET.password);
    }
    const listing = relayHarness();
    failingSecret(listing, 'password');
    const response = await relayGet(listing, '/list/object/items?search=database');
    expect(response.status).toBe(503);
    expect(listing.audit.events.at(-1)?.itemId).toBe(RELAY_ID.database);
  });

  it('answers 500 and logs when a route throws', async () => {
    const harness = relayHarness();
    vi.spyOn(harness.vault, 'getItem').mockRejectedValue(new Error('boom'));
    const response = await relayGet(harness, `/object/item/${RELAY_ID.database}`);
    expect(response.status).toBe(500);
    expect(await json(response)).toStrictEqual({ success: false, message: 'Relay error.' });
    expect(harness.logged()).toContain('relay request failed');
  });
});
