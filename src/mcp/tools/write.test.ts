import { describe, expect, it } from 'vitest';

import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { unwrapOk } from '../../test-support/result.ts';
import { failureCode, runOk } from '../../test-support/run-tool.ts';
import { CANARY } from '../../test-support/vault-fixture.ts';
import { VaultError } from '../../vault/client.ts';

import { toolCreateFolder, toolCreateItem, toolTrashItem, toolUpdateItem } from './write.ts';

const GENERATED = 'Aa1!'.repeat(6);
const LOGIN = { type: 'login', name: 'x' };

function downVault(): InMemoryVaultClient {
  const vault = new InMemoryVaultClient();
  vault.failWith(new VaultError('vault_unavailable', 'down'));
  return vault;
}

describe('create_item', () => {
  it('§6.2 creates a login with a generated password the agent never sees', async () => {
    const vault = new InMemoryVaultClient();
    const output = await runOk(toolCreateItem, vault, {
      type: 'login',
      name: 'New Login',
      username: 'bob',
      uris: ['https://new.example'],
      folder_id: 'folder-work',
      notes: 'created by test',
      favorite: true,
      generate_password: true,
    });
    expect(output['item']).toMatchObject({
      id: 'item-new-1',
      name: 'New Login',
      folder_id: 'folder-work',
      favorite: true,
      has_notes: true,
      login: {
        username: 'bob',
        uris: ['https://new.example'],
        has_password: true,
        has_totp: false,
      },
    });
    expect(JSON.stringify(output)).not.toContain(GENERATED);
    expect(vault.storedSecrets('item-new-1')).toStrictEqual({
      password: GENERATED,
      notes: 'created by test',
    });
  });

  it('§6.2 stores an explicit password and creates secure notes without a login section', async () => {
    const vault = new InMemoryVaultClient();
    await runOk(toolCreateItem, vault, { ...LOGIN, name: 'Explicit', password: 'given-pw' });
    expect(vault.storedSecrets('item-new-1')).toStrictEqual({ password: 'given-pw' });
    const note = await runOk(toolCreateItem, vault, { type: 'secureNote', name: 'Note' });
    expect(note['item']).toMatchObject({
      id: 'item-new-2',
      type: 'secureNote',
      login: null,
      has_notes: false,
    });
    expect(vault.storedSecrets('item-new-2')).toStrictEqual({});
  });

  it('§6.2 refuses both an explicit and a generated password', async () => {
    const conflicting = { ...LOGIN, password: 'a', generate_password: true };
    expect(await failureCode(toolCreateItem, new InMemoryVaultClient(), conflicting)).toBe(
      'conflicting_arguments',
    );
  });

  it('VAULT-5 maps generation, creation and validation failures', async () => {
    expect(
      await failureCode(toolCreateItem, downVault(), { ...LOGIN, generate_password: true }),
    ).toBe('vault_unavailable');
    expect(await failureCode(toolCreateItem, downVault(), LOGIN)).toBe('vault_unavailable');
    expect(
      await failureCode(toolCreateItem, new InMemoryVaultClient(), { ...LOGIN, name: ' ' }),
    ).toBe('invalid_item');
  });
});

describe('update_item', () => {
  it('§6.2 patches only the fields given and rotates the password on request', async () => {
    const vault = new InMemoryVaultClient();
    const output = await runOk(toolUpdateItem, vault, {
      item_id: 'item-login',
      name: 'Renamed',
      username: 'alice2',
      uris: [],
      notes: 'new notes',
      folder_id: null,
      favorite: false,
      generate_password: true,
    });
    expect(output['item']).toMatchObject({
      name: 'Renamed',
      folder_id: null,
      favorite: false,
      login: { username: 'alice2', uris: [], has_password: true },
    });
    expect(vault.storedSecrets('item-login')).toMatchObject({
      password: GENERATED,
      notes: 'new notes',
    });
    expect(JSON.stringify(output)).not.toContain(GENERATED);
  });

  it('§6.2 leaves everything untouched when only the id is given', async () => {
    const vault = new InMemoryVaultClient();
    const before = unwrapOk(await vault.getItem('item-login'));
    const output = await runOk(toolUpdateItem, vault, { item_id: 'item-login' });
    expect(output['item']).toMatchObject({
      name: before.name,
      folder_id: before.folderId,
      favorite: before.favorite,
    });
    expect(vault.storedSecrets('item-login')?.password).toBe(CANARY.password);
  });

  it('§6.2 stores an explicit password and refuses conflicting options', async () => {
    const vault = new InMemoryVaultClient();
    await runOk(toolUpdateItem, vault, { item_id: 'item-login', password: 'rotated' });
    expect(vault.storedSecrets('item-login')?.password).toBe('rotated');
    const conflicting = { item_id: 'item-login', password: 'a', generate_password: true };
    expect(await failureCode(toolUpdateItem, vault, conflicting)).toBe('conflicting_arguments');
  });

  it('§5.4 maps not_found and vault failures', async () => {
    expect(
      await failureCode(toolUpdateItem, new InMemoryVaultClient(), { item_id: 'nope', name: 'x' }),
    ).toBe('not_found');
    expect(
      await failureCode(toolUpdateItem, downVault(), { item_id: 'item-login', name: 'x' }),
    ).toBe('vault_unavailable');
  });
});

describe('trash_item', () => {
  it('§6.2 soft-deletes and confirms', async () => {
    const vault = new InMemoryVaultClient();
    expect(await runOk(toolTrashItem, vault, { item_id: 'item-login' })).toStrictEqual({
      item_id: 'item-login',
      trashed: true,
    });
    const after = unwrapOk(await vault.getItem('item-login'));
    expect(after.deletedDate).toBe('2026-09-22T10:00:00.000Z');
  });

  it('§5.4 maps not_found and vault failures', async () => {
    expect(await failureCode(toolTrashItem, new InMemoryVaultClient(), { item_id: 'nope' })).toBe(
      'not_found',
    );
    expect(await failureCode(toolTrashItem, downVault(), { item_id: 'item-login' })).toBe(
      'vault_unavailable',
    );
  });
});

describe('create_folder', () => {
  it('§6.2 creates a folder and lists it afterwards', async () => {
    const vault = new InMemoryVaultClient();
    expect(await runOk(toolCreateFolder, vault, { name: 'Archive' })).toStrictEqual({
      folder: { id: 'folder-new-1', name: 'Archive' },
    });
    const folders = unwrapOk(await vault.listFolders());
    expect(folders.map((folder) => folder.name)).toContain('Archive');
  });

  it('VAULT-5 maps a vault failure', async () => {
    expect(await failureCode(toolCreateFolder, downVault(), { name: 'x' })).toBe(
      'vault_unavailable',
    );
  });
});
