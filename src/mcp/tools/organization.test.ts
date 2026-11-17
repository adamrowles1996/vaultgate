import { describe, expect, it } from 'vitest';

import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { failureCode, runOk } from '../../test-support/run-tool.ts';
import { CANARY } from '../../test-support/vault-fixture.ts';
import { VaultError } from '../../vault/client.ts';

import { toolMoveItemToCollection } from './organization.ts';
import { toolCreateItem } from './write.ts';

const WRITABLE = { writeOrganizations: ['org-acme'] };
const ELSEWHERE = { writeOrganizations: ['org-other'] };
const NOTE = { type: 'secureNote', name: 'Shared note', notes: 'dummy' };
const IN_INFRA = { organization_id: 'org-acme', collection_ids: ['collection-infra'] };

describe('create_item with a collection_id', () => {
  it('MCP-19 creates the item in the collection and its organisation', async () => {
    const vault = new InMemoryVaultClient();
    const output = await runOk(
      toolCreateItem,
      vault,
      { ...NOTE, collection_id: 'collection-infra' },
      WRITABLE,
    );
    expect(output['item']).toMatchObject({ id: 'item-new-1', ...IN_INFRA });
    expect(JSON.stringify(output)).not.toContain('dummy');
  });

  it('MCP-19 without a collection_id creates the item in the account vault', async () => {
    const output = await runOk(toolCreateItem, new InMemoryVaultClient(), NOTE, WRITABLE);
    expect(output['item']).toMatchObject({ organization_id: null, collection_ids: [] });
  });

  it('MCP-19 refuses an organisation the operator has not listed, and writes nothing', async () => {
    const vault = new InMemoryVaultClient();
    const input = { ...NOTE, collection_id: 'collection-infra' };
    expect(await failureCode(toolCreateItem, vault, input, ELSEWHERE)).toBe('policy_denied');
    expect(await failureCode(toolCreateItem, vault, input)).toBe('policy_denied');
    expect(unwrapSearch(await vault.searchItems({ text: 'Shared note', limit: 50 }))).toBe(0);
  });

  it('MCP-19 reports a collection the account cannot see as not_found', async () => {
    const vault = new InMemoryVaultClient();
    const input = { ...NOTE, collection_id: 'collection-unknown' };
    expect(await failureCode(toolCreateItem, vault, input, WRITABLE)).toBe('not_found');
  });

  it('MCP-19 passes a vault failure through while looking the collection up', async () => {
    const vault = new InMemoryVaultClient();
    vault.failWith(new VaultError('vault_unavailable', 'down'));
    const input = { ...NOTE, collection_id: 'collection-infra' };
    expect(await failureCode(toolCreateItem, vault, input, WRITABLE)).toBe('vault_unavailable');
  });
});

function unwrapSearch(result: Awaited<ReturnType<InMemoryVaultClient['searchItems']>>): number {
  return result.ok ? result.value.length : -1;
}

describe('move_item_to_collection', () => {
  const MOVE = { item_id: 'item-note', collection_id: 'collection-infra' };

  it('MCP-20 moves an item of the account vault into the collection', async () => {
    const vault = new InMemoryVaultClient();
    const output = await runOk(toolMoveItemToCollection, vault, MOVE, WRITABLE);
    expect(output['item']).toMatchObject({ id: 'item-note', ...IN_INFRA });
    expect(JSON.stringify(output)).not.toContain(CANARY.secureNote);
  });

  it('MCP-20 refuses an organisation the operator has not listed, and moves nothing', async () => {
    const vault = new InMemoryVaultClient();
    expect(await failureCode(toolMoveItemToCollection, vault, MOVE, ELSEWHERE)).toBe(
      'policy_denied',
    );
    const item = await vault.getItem('item-note');
    expect(item.ok && item.value.organizationId).toBeNull();
  });

  it('MCP-20 refuses an item already in an organisation', async () => {
    const vault = new InMemoryVaultClient();
    const input = { ...MOVE, item_id: 'item-login' };
    expect(await failureCode(toolMoveItemToCollection, vault, input, WRITABLE)).toBe(
      'item_in_organization',
    );
  });

  it('MCP-20 refuses a trashed item', async () => {
    const vault = new InMemoryVaultClient();
    const input = { ...MOVE, item_id: 'item-trashed' };
    expect(await failureCode(toolMoveItemToCollection, vault, input, WRITABLE)).toBe(
      'item_in_trash',
    );
  });

  it('MCP-20 reports an unknown item or collection as not_found', async () => {
    const vault = new InMemoryVaultClient();
    const unknownItem = { ...MOVE, item_id: 'item-missing' };
    const unknownCollection = { ...MOVE, collection_id: 'collection-unknown' };
    expect(await failureCode(toolMoveItemToCollection, vault, unknownItem, WRITABLE)).toBe(
      'not_found',
    );
    expect(await failureCode(toolMoveItemToCollection, vault, unknownCollection, WRITABLE)).toBe(
      'not_found',
    );
  });

  it('MCP-20 passes a failed move through', async () => {
    const vault = new InMemoryVaultClient();
    vault.moveItem = (): ReturnType<InMemoryVaultClient['moveItem']> =>
      Promise.resolve({ ok: false, error: new VaultError('invalid_item', 'refused') });
    expect(await failureCode(toolMoveItemToCollection, vault, MOVE, WRITABLE)).toBe('invalid_item');
  });

  it('MCP-13 audits the moved item id', () => {
    expect(toolMoveItemToCollection.auditReference(MOVE)).toStrictEqual({ itemId: 'item-note' });
  });
});
