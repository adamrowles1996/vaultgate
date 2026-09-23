import { describe, expect, it } from 'vitest';

import { CANARY, FIXTURE_IDS, fixtureItems } from '../test-support/fake-vault-fixture.ts';

import { newItemBody, patchedItemBody } from './items.ts';
import { itemSchema, type RawItem } from './types.ts';

function raw(id: string): RawItem {
  const item = fixtureItems().find((candidate) => candidate['id'] === id);
  return itemSchema.parse(item);
}

describe('newItemBody', () => {
  it('builds a login item body', () => {
    expect(
      newItemBody({
        type: 'login',
        name: 'New',
        folderId: 'f1',
        notes: 'n',
        favorite: true,
        login: { username: 'u', password: 'p', uris: ['https://a.example'] },
      }),
    ).toStrictEqual({
      organizationId: null,
      collectionIds: null,
      folderId: 'f1',
      name: 'New',
      notes: 'n',
      favorite: true,
      fields: [],
      reprompt: 0,
      type: 1,
      login: {
        username: 'u',
        password: 'p',
        totp: null,
        uris: [{ match: null, uri: 'https://a.example' }],
      },
    });
  });

  it('builds a secure note body with defaults', () => {
    expect(newItemBody({ type: 'secureNote', name: 'Note' })).toStrictEqual({
      organizationId: null,
      collectionIds: null,
      folderId: null,
      name: 'Note',
      notes: null,
      favorite: false,
      fields: [],
      reprompt: 0,
      type: 2,
      secureNote: { type: 0 },
    });
  });

  it('builds an empty login when no login fields are given', () => {
    expect(newItemBody({ type: 'login', name: 'Bare' })['login']).toStrictEqual({
      username: null,
      password: null,
      totp: null,
      uris: [],
    });
  });
});

describe('patchedItemBody', () => {
  it('applies every patch field over the raw item and keeps unknown fields', () => {
    const original = raw(FIXTURE_IDS.login);
    const body = patchedItemBody(original, {
      name: 'Renamed',
      folderId: null,
      notes: 'new notes',
      favorite: false,
      login: { username: 'carol', uris: ['https://b.example'] },
    });
    expect(body).toStrictEqual({
      ...original,
      name: 'Renamed',
      folderId: null,
      notes: 'new notes',
      favorite: false,
      login: {
        ...original.login,
        username: 'carol',
        password: CANARY.password,
        uris: [{ uri: 'https://b.example' }],
      },
    });
  });

  it('leaves everything untouched for an empty patch', () => {
    const original = raw(FIXTURE_IDS.login);
    expect(patchedItemBody(original, {})).toStrictEqual({ ...original });
  });

  it('creates a login section on an item without one', () => {
    const original = raw(FIXTURE_IDS.secureNote);
    const body = patchedItemBody(original, { login: { password: 'p' } });
    expect(body['login']).toStrictEqual({ username: null, password: 'p', uris: [] });
    expect(body['folderId']).toBeNull();
    expect(body['favorite']).toBe(false);
  });

  it('defaults notes, favourite, folder and login on a bare item', () => {
    const bare: RawItem = {
      id: 'x',
      name: 'bare',
      type: 2,
      revisionDate: '2026-01-01T00:00:00.000Z',
    };
    expect(patchedItemBody(bare, {})).toStrictEqual({
      ...bare,
      name: 'bare',
      folderId: null,
      notes: null,
      favorite: false,
      login: null,
    });
    expect(patchedItemBody(bare, { login: { username: 'u' } })['login']).toStrictEqual({
      username: 'u',
      password: null,
      uris: [],
    });
  });

  it('ACT-83 writes a named custom field in place, keeping its kind, and adds an unknown name as hidden', () => {
    const original = raw(FIXTURE_IDS.login);
    const existing = original.fields?.[1];
    const body = patchedItemBody(original, {
      customFields: [
        { name: existing?.name ?? '', value: 'rotated' },
        { name: 'Graph refresh token', value: 'brand-new' },
      ],
    });
    expect(body['fields']).toStrictEqual([
      original.fields?.[0],
      { ...existing, value: 'rotated' },
      ...(original.fields ?? []).slice(2),
      { name: 'Graph refresh token', value: 'brand-new', type: 1 },
    ]);
  });

  it('ACT-83 adds the fields list to an item that has none and leaves an unnamed field alone', () => {
    const bare: RawItem = {
      id: 'x',
      name: 'bare',
      type: 2,
      revisionDate: '2026-01-01T00:00:00.000Z',
    };
    expect(
      patchedItemBody(bare, { customFields: [{ name: 'f', value: 'v' }] })['fields'],
    ).toStrictEqual([{ name: 'f', value: 'v', type: 1 }]);
    const unnamed: RawItem = { ...bare, fields: [{ name: null, value: 'keep', type: 0 }] };
    expect(
      patchedItemBody(unnamed, { customFields: [{ name: 'f', value: 'v' }] })['fields'],
    ).toStrictEqual([
      { name: null, value: 'keep', type: 0 },
      { name: 'f', value: 'v', type: 1 },
    ]);
  });

  it('keeps existing uris when the patch does not mention them', () => {
    const original = raw(FIXTURE_IDS.login);
    const body = patchedItemBody(original, { login: { password: 'p' } });
    expect(body['login']).toStrictEqual({ ...original.login, username: 'alice', password: 'p' });
  });
});
