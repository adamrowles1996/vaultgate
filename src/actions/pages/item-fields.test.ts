import { describe, expect, it } from 'vitest';

import { compact } from '../../test-support/identity-app.ts';

import { itemFields, offeredFields, pickedSelector } from './item-fields.ts';
import { itemLine } from './item-view.ts';

import type { ItemSummary } from '../../vault/client.ts';

function item(overrides: Partial<ItemSummary>): ItemSummary {
  return {
    id: 'item-x',
    name: 'X',
    type: 'login',
    folderId: null,
    organizationId: null,
    collectionIds: [],
    favorite: false,
    revisionDate: '2026-09-01T09:00:00.000Z',
    deletedDate: null,
    login: null,
    hasNotes: false,
    customFields: [],
    ...overrides,
  };
}

const EMPTY_LOGIN = { username: null, uris: [], hasPassword: false, hasTotp: false };

function line(uri: string): string {
  return compact(itemLine(item({ login: { ...EMPTY_LOGIN, uris: [uri] } })).markup);
}

describe('the fields an item offers a mapping', () => {
  it('ACT-4 lists what the item carries, a secret field without its value', () => {
    expect(itemFields(item({ login: EMPTY_LOGIN }))).toStrictEqual([]);
    expect(itemFields(item({ type: 'secureNote', hasNotes: true }))).toStrictEqual([
      { selector: 'notes', label: 'Notes', isSecret: true },
    ]);
    expect(itemFields(item({ type: 'card' })).map((field) => field.selector)).toStrictEqual([
      'card.number',
      'card.code',
    ]);
    const custom = itemFields(
      item({
        type: 'identity',
        customFields: [
          { name: 'host', kind: 'text', value: null },
          { name: 'token', kind: 'hidden', value: null },
          { name: 'enabled', kind: 'boolean', value: 'true' },
          { name: 'alias', kind: 'linked', value: null },
        ],
      }),
    );
    expect(custom).toStrictEqual([
      { selector: 'custom.host', label: 'host', isSecret: false, value: '' },
      { selector: 'custom.token', label: 'token', isSecret: true },
    ]);
  });

  it('ACT-4 offers a secret any field but the login name, and preselects the default or none', () => {
    const fields = itemFields(
      item({ login: { ...EMPTY_LOGIN, username: 'svc', hasPassword: true } }),
    );
    expect(offeredFields(fields, { role: 'username', fallback: 'login.username' })).toHaveLength(2);
    expect(
      offeredFields(fields, { role: 'secret', fallback: 'password' }).map(
        (field) => field.selector,
      ),
    ).toStrictEqual(['password']);
    expect(pickedSelector('custom.pw', { role: 'secret', fallback: 'password' })).toBe('custom.pw');
    expect(pickedSelector('', { role: 'secret', fallback: 'password' })).toBe('password');
    expect(pickedSelector('', { role: 'secret', optional: true })).toBe('');
  });

  it('ACT-4 shows an item’s first address by its host, or as written when it names none', () => {
    expect(line('https://db.example.com/admin')).toContain('>db.example.com</span>');
    expect(line('db.example.com:1433')).toContain('>db.example.com:1433</span>');
    expect(line('not a url')).toContain('>not a url</span>');
  });
});
