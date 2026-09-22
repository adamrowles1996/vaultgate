import { describe, expect, it } from 'vitest';

import { fail } from '../../result.ts';
import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { failureCode, runOk } from '../../test-support/run-tool.ts';
import { VaultError } from '../../vault/client.ts';

import {
  toolGetItem,
  toolListCollections,
  toolListFolders,
  toolSearchItems,
  toolVaultStatus,
} from './read.ts';

const DOWN = new VaultError('vault_unavailable', 'bw serve is not running');

function downVault(): InMemoryVaultClient {
  const vault = new InMemoryVaultClient();
  vault.failWith(DOWN);
  return vault;
}

class CountFails extends InMemoryVaultClient {
  override searchItems(): ReturnType<InMemoryVaultClient['searchItems']> {
    return Promise.resolve(fail(new VaultError('vault_protocol_error', 'bad shape')));
  }
}

async function searchIds(vault: InMemoryVaultClient, input: unknown): Promise<string[]> {
  const output = await runOk(toolSearchItems, vault, input);
  return (output['items'] as { id: string }[]).map((item) => item.id);
}

describe('vault_status', () => {
  it('§6.2 reports connection state and the live item count without item data', async () => {
    const output = await runOk(toolVaultStatus, new InMemoryVaultClient(), {});
    expect(output).toStrictEqual({
      server_url: 'https://vault.bitwarden.com',
      user_email_masked: 'a***@example.com',
      state: 'unlocked',
      last_sync_at: '2026-09-22T10:00:00.000Z',
      item_count: 5,
    });
  });

  it('VAULT-5 maps a status failure and a count failure to the vault error', async () => {
    expect(await failureCode(toolVaultStatus, downVault(), {})).toBe('vault_unavailable');
    expect(await failureCode(toolVaultStatus, new CountFails(), {})).toBe('vault_protocol_error');
  });
});

describe('search_items', () => {
  it('§6.2 returns summaries with defaults applied and no secret fields', async () => {
    const output = await runOk(toolSearchItems, new InMemoryVaultClient(), {});
    expect(output['truncated']).toBe(false);
    const items = output['items'] as { id: string; login: unknown }[];
    expect(items.map((item) => item.id)).toStrictEqual([
      'item-login',
      'item-note',
      'item-card',
      'item-identity',
      'item-ssh',
    ]);
    expect(items[0]?.login).toStrictEqual({
      username: 'alice@example.com',
      uris: ['https://app.example.com/login'],
      has_password: true,
      has_totp: true,
    });
    expect(JSON.stringify(output)).not.toContain('CANARY');
  });

  it('§6.2 honours every filter', async () => {
    const vault = new InMemoryVaultClient();
    expect(await searchIds(vault, { query: 'alice' })).toStrictEqual([
      'item-login',
      'item-identity',
    ]);
    expect(await searchIds(vault, { query: 'alice@' })).toStrictEqual(['item-login']);
    expect(await searchIds(vault, { type: 'card' })).toStrictEqual(['item-card']);
    expect(await searchIds(vault, { folder_id: 'folder-personal' })).toStrictEqual(['item-note']);
    expect(await searchIds(vault, { collection_id: 'collection-infra' })).toStrictEqual([
      'item-login',
    ]);
    expect(await searchIds(vault, { url: 'app.example.com' })).toStrictEqual(['item-login']);
    expect(await searchIds(vault, { include_trash: true, query: 'login' })).toStrictEqual([
      'item-login',
      'item-trashed',
    ]);
  });

  it('MCP-5 caps at 50 and flags truncation', async () => {
    const output = await runOk(toolSearchItems, new InMemoryVaultClient(), { limit: 2 });
    expect((output['items'] as unknown[]).length).toBe(2);
    expect(output['truncated']).toBe(true);
    expect(() => toolSearchItems.inputSchema.parse({ limit: 51 })).toThrow('50');
  });

  it('VAULT-5 maps a vault failure', async () => {
    expect(await failureCode(toolSearchItems, downVault(), {})).toBe('vault_unavailable');
  });
});

describe('get_item', () => {
  it('§6.2 reports secret fields as present or absent, never their values', async () => {
    const output = await runOk(toolGetItem, new InMemoryVaultClient(), { item_id: 'item-login' });
    expect(output['secrets']).toStrictEqual({
      password: { present: true },
      totp: { present: true },
      notes: { present: true },
      card: { present: false },
      identity: { present: false },
      ssh_private_key: { present: false },
      hidden_fields: ['API key'],
    });
    expect(JSON.stringify(output)).not.toContain('CANARY');
  });

  it('§6.2 handles items without a login section', async () => {
    const output = await runOk(toolGetItem, new InMemoryVaultClient(), { item_id: 'item-card' });
    expect(output['secrets']).toMatchObject({
      password: { present: false },
      totp: { present: false },
      card: { present: true },
    });
    expect((output['item'] as { login: unknown }).login).toBeNull();
  });

  it('§5.4 maps an unknown id to not_found', async () => {
    expect(await failureCode(toolGetItem, new InMemoryVaultClient(), { item_id: 'nope' })).toBe(
      'not_found',
    );
  });
});

describe('list_folders and list_collections', () => {
  it('§6.2 return ids and names', async () => {
    const vault = new InMemoryVaultClient();
    expect(await runOk(toolListFolders, vault, {})).toStrictEqual({
      folders: [
        { id: 'folder-work', name: 'Work' },
        { id: 'folder-personal', name: 'Personal' },
      ],
    });
    expect(await runOk(toolListCollections, vault, {})).toStrictEqual({
      collections: [
        { id: 'collection-infra', name: 'Infrastructure', organization_id: 'org-acme' },
      ],
    });
  });

  it('VAULT-5 map a vault failure', async () => {
    expect(await failureCode(toolListFolders, downVault(), {})).toBe('vault_unavailable');
    expect(await failureCode(toolListCollections, downVault(), {})).toBe('vault_unavailable');
  });
});
