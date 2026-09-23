import { describe, expect, it } from 'vitest';

import { FIXTURE_ITEMS } from '../test-support/vault-fixture.ts';

import { isFieldPresent, parseFieldSelector, parseSecretField } from './fields.ts';

import type { ItemSummary } from './client.ts';

function item(id: string): ItemSummary {
  const found = FIXTURE_ITEMS.find((stored) => stored.summary.id === id);
  if (found === undefined) {
    throw new Error(`no fixture item ${id}`);
  }
  return found.summary;
}

describe('parseFieldSelector', () => {
  it('ACT-4 accepts login.username besides every get_secret selector', () => {
    expect(parseFieldSelector('login.username')).toStrictEqual({ kind: 'username' });
    expect(parseFieldSelector('password')).toStrictEqual({ kind: 'password' });
    expect(parseFieldSelector('custom.API key')).toStrictEqual({
      kind: 'customField',
      name: 'API key',
    });
    expect(parseFieldSelector('identity.ssn')).toStrictEqual({ kind: 'identity', field: 'ssn' });
    expect(parseFieldSelector('login.password')).toBeUndefined();
    expect(parseFieldSelector('custom.')).toBeUndefined();
    expect(parseSecretField('login.username')).toBeUndefined();
  });
});

describe('isFieldPresent', () => {
  it('ACT-4 judges presence from the item summary flags and field list, never from a value', () => {
    const login = item('item-login');
    expect(isFieldPresent(login, { kind: 'username' })).toBe(true);
    expect(isFieldPresent(login, { kind: 'password' })).toBe(true);
    expect(isFieldPresent(login, { kind: 'totp' })).toBe(true);
    expect(isFieldPresent(login, { kind: 'notes' })).toBe(true);
    expect(isFieldPresent(login, { kind: 'customField', name: 'API key' })).toBe(true);
    expect(isFieldPresent(login, { kind: 'customField', name: 'missing' })).toBe(false);
    expect(isFieldPresent(login, { kind: 'card', field: 'number' })).toBe(false);
    expect(isFieldPresent(item('item-card'), { kind: 'card', field: 'code' })).toBe(true);
    expect(isFieldPresent(item('item-identity'), { kind: 'identity', field: 'ssn' })).toBe(true);
    expect(isFieldPresent(item('item-ssh'), { kind: 'sshKey', field: 'privateKey' })).toBe(true);
    expect(isFieldPresent(item('item-note'), { kind: 'sshKey', field: 'privateKey' })).toBe(false);
    expect(isFieldPresent(item('item-note'), { kind: 'identity', field: 'ssn' })).toBe(false);
  });

  it('ACT-4 reports no login field on an item without a login, and a missing username, password or TOTP', () => {
    const note = item('item-note');
    expect(isFieldPresent(note, { kind: 'username' })).toBe(false);
    expect(isFieldPresent(note, { kind: 'password' })).toBe(false);
    expect(isFieldPresent(note, { kind: 'totp' })).toBe(false);
    expect(isFieldPresent(note, { kind: 'notes' })).toBe(true);
    const bare: ItemSummary = {
      ...item('item-login'),
      login: { username: null, uris: [], hasPassword: false, hasTotp: false },
    };
    expect(isFieldPresent(bare, { kind: 'username' })).toBe(false);
    expect(isFieldPresent(bare, { kind: 'password' })).toBe(false);
    expect(isFieldPresent(bare, { kind: 'totp' })).toBe(false);
  });
});
