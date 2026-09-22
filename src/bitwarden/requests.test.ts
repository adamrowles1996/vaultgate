import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVER_URL,
  fieldPath,
  generatePath,
  itemPath,
  maskEmail,
  searchPath,
  toVaultStatus,
  unavailableStatus,
} from './requests.ts';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });

  it('masks a value without an @ entirely after its first character', () => {
    expect(maskEmail('alice')).toBe('a***');
  });

  it('returns null for a missing or empty address', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('')).toBeNull();
  });
});

describe('toVaultStatus', () => {
  it('maps the status template and falls back to the configured server', () => {
    expect(
      toVaultStatus(
        { serverUrl: null, lastSync: null, userEmail: 'bob@example.com', status: 'locked' },
        DEFAULT_SERVER_URL,
      ),
    ).toStrictEqual({
      serverUrl: DEFAULT_SERVER_URL,
      userEmailMasked: 'b***@example.com',
      state: 'locked',
      lastSyncAt: null,
    });
    expect(
      toVaultStatus(
        {
          serverUrl: 'https://vault.example.test',
          lastSync: '2026-09-22T12:00:00.000Z',
          userEmail: null,
          status: 'unlocked',
        },
        DEFAULT_SERVER_URL,
      ),
    ).toStrictEqual({
      serverUrl: 'https://vault.example.test',
      userEmailMasked: null,
      state: 'unlocked',
      lastSyncAt: '2026-09-22T12:00:00.000Z',
    });
  });
});

describe('unavailableStatus', () => {
  it('reports the configured server with no account details', () => {
    expect(unavailableStatus('https://vault.example.test')).toStrictEqual({
      serverUrl: 'https://vault.example.test',
      userEmailMasked: null,
      state: 'unavailable',
      lastSyncAt: null,
    });
  });
});

describe('paths', () => {
  it('encodes item ids', () => {
    expect(itemPath('a b/c')).toBe('/object/item/a%20b%2Fc');
    expect(fieldPath('totp', 'a b')).toBe('/object/totp/a%20b');
  });

  it('lists items with no query when nothing is filtered', () => {
    expect(searchPath({ limit: 10 }, false)).toBe('/list/object/items');
  });

  it('passes every filter through as a bw serve query parameter', () => {
    expect(
      searchPath(
        {
          text: 'git hub',
          folderId: 'f1',
          collectionId: 'c1',
          url: 'https://example.com/?a=1',
          limit: 10,
        },
        true,
      ),
    ).toBe(
      '/list/object/items?search=git+hub&folderid=f1&collectionid=c1&url=https%3A%2F%2Fexample.com%2F%3Fa%3D1&trash=true',
    );
  });

  it('builds the generate query from the options', () => {
    expect(generatePath({ length: 20, uppercase: true, special: false })).toBe(
      '/generate?length=20&uppercase=true&special=false',
    );
  });
});
