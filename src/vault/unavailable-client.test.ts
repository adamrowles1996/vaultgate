import { describe, expect, it } from 'vitest';

import { unwrapFail } from '../test-support/result.ts';

import { UnavailableVaultClient } from './unavailable-client.ts';

import type { VaultClient } from './client.ts';

const client: VaultClient = new UnavailableVaultClient();

const CALLS: readonly [string, () => Promise<{ ok: boolean }>][] = [
  ['status', () => client.status()],
  ['sync', () => client.sync()],
  ['searchItems', () => client.searchItems({ limit: 1 })],
  ['getItem', () => client.getItem('x')],
  ['getSecret', () => client.getSecret('x', { kind: 'password' })],
  ['listFolders', () => client.listFolders()],
  ['listCollections', () => client.listCollections()],
  [
    'generatePassword',
    () =>
      client.generatePassword({
        length: 8,
        uppercase: true,
        lowercase: true,
        numbers: true,
        special: true,
      }),
  ],
  [
    'generatePassphrase',
    () =>
      client.generatePassphrase({
        words: 3,
        separator: '-',
        capitalize: false,
        includeNumber: false,
      }),
  ],
  ['createItem', () => client.createItem({ type: 'login', name: 'x' })],
  ['updateItem', () => client.updateItem('x', { name: 'y' })],
  ['trashItem', () => client.trashItem('x')],
  ['createFolder', () => client.createFolder('x')],
];

describe('UnavailableVaultClient', () => {
  it.each(CALLS)('VAULT-5 %s fails with vault_unavailable', async (_name, call) => {
    const result = await call();
    const error = unwrapFail(result as Parameters<typeof unwrapFail>[0]);
    expect(error.name).toBe('VaultError');
    expect(error).toMatchObject({ code: 'vault_unavailable' });
  });
});
