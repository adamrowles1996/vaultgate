import { describe, expect, it } from 'vitest';

import { CANARY, FIXTURE_IDS, fixtureItems } from '../test-support/fake-vault-fixture.ts';

import { itemTypeOf, secretFromItem, summariseItem } from './items.ts';
import { itemSchema, type RawItem } from './types.ts';

function raw(id: string): RawItem {
  const item = fixtureItems().find((candidate) => candidate['id'] === id);
  return itemSchema.parse(item);
}

const CANARIES = Object.values(CANARY);

describe('summariseItem', () => {
  it('VAULT-13 summarises a login with its custom fields and no secret values', () => {
    const summary = summariseItem(raw(FIXTURE_IDS.login));
    expect(summary).toStrictEqual({
      id: FIXTURE_IDS.login,
      name: 'Example login',
      type: 'login',
      folderId: FIXTURE_IDS.folder,
      organizationId: null,
      collectionIds: [],
      favorite: true,
      revisionDate: '2026-09-01T09:00:00.000Z',
      deletedDate: null,
      login: {
        username: 'alice',
        uris: ['https://example.com/login'],
        hasPassword: true,
        hasTotp: true,
      },
      hasNotes: true,
      customFields: [
        { name: 'environment', kind: 'text', value: 'production' },
        { name: 'api-key', kind: 'hidden', value: null },
        { name: 'mfa', kind: 'boolean', value: 'true' },
        { name: 'linked', kind: 'linked', value: null },
      ],
    });
    const serialised = JSON.stringify(summary);
    for (const canary of CANARIES) {
      expect(serialised).not.toContain(canary);
    }
  });

  it('VAULT-13 summarises every other item type without its secret fields', () => {
    const types = ['secureNote', 'card', 'identity', 'sshKey'] as const;
    for (const type of types) {
      const summary = summariseItem(raw(FIXTURE_IDS[type]));
      expect(summary.type).toBe(type);
      expect(summary.login).toBeNull();
      expect(summary.customFields).toStrictEqual([]);
      const serialised = JSON.stringify(summary);
      for (const canary of CANARIES) {
        expect(serialised).not.toContain(canary);
      }
    }
  });

  it('reports a trashed organisation item with its collection ids', () => {
    const summary = summariseItem(raw(FIXTURE_IDS.trashedLogin));
    expect(summary.deletedDate).toBe('2026-09-10T12:00:00.000Z');
    expect(summary.organizationId).toBe(FIXTURE_IDS.organization);
    expect(summary.collectionIds).toStrictEqual([FIXTURE_IDS.collection]);
    expect(summary.login).toStrictEqual({
      username: 'bob',
      uris: [],
      hasPassword: true,
      hasTotp: false,
    });
  });

  it('defaults every optional field the CLI may omit', () => {
    const summary = summariseItem({
      id: 'x',
      name: 'bare',
      type: 1,
      revisionDate: '2026-01-01T00:00:00.000Z',
      login: { username: null, password: '', uris: null },
      fields: [{ name: null, value: 'v', type: 0 }],
    });
    expect(summary).toStrictEqual({
      id: 'x',
      name: 'bare',
      type: 'login',
      folderId: null,
      organizationId: null,
      collectionIds: [],
      favorite: false,
      revisionDate: '2026-01-01T00:00:00.000Z',
      deletedDate: null,
      login: { username: null, uris: [], hasPassword: false, hasTotp: false },
      hasNotes: false,
      customFields: [{ name: '', kind: 'text', value: 'v' }],
    });
  });
});

describe('itemTypeOf', () => {
  it('names each numeric type', () => {
    expect(itemTypeOf(raw(FIXTURE_IDS.card))).toBe('card');
    expect(itemTypeOf(raw(FIXTURE_IDS.identity))).toBe('identity');
  });
});

describe('secretFromItem', () => {
  it('reads card, identity, ssh key and hidden custom fields', () => {
    expect(secretFromItem(raw(FIXTURE_IDS.card), { kind: 'card', field: 'number' })).toBe(
      CANARY.cardNumber,
    );
    expect(secretFromItem(raw(FIXTURE_IDS.card), { kind: 'card', field: 'code' })).toBe(
      CANARY.cardCode,
    );
    expect(
      secretFromItem(raw(FIXTURE_IDS.identity), { kind: 'identity', field: 'passportNumber' }),
    ).toBe(CANARY.identityPassport);
    expect(secretFromItem(raw(FIXTURE_IDS.sshKey), { kind: 'sshKey', field: 'privateKey' })).toBe(
      CANARY.sshPrivateKey,
    );
    expect(secretFromItem(raw(FIXTURE_IDS.login), { kind: 'customField', name: 'api-key' })).toBe(
      CANARY.hiddenField,
    );
  });

  it('returns undefined for absent, empty or foreign fields', () => {
    const login = raw(FIXTURE_IDS.login);
    expect(secretFromItem(login, { kind: 'card', field: 'number' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'identity', field: 'passportNumber' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'sshKey', field: 'privateKey' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'customField', name: 'missing' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'customField', name: 'linked' })).toBeUndefined();
    expect(
      secretFromItem(raw(FIXTURE_IDS.identity), { kind: 'identity', field: 'username' }),
    ).toBeUndefined();
  });

  it('never reads the endpoint-backed fields from the item body', () => {
    const login = raw(FIXTURE_IDS.login);
    expect(secretFromItem(login, { kind: 'password' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'totp' })).toBeUndefined();
    expect(secretFromItem(login, { kind: 'notes' })).toBeUndefined();
  });
});
