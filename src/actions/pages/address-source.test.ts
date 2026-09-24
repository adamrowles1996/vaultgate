import { describe, expect, it } from 'vitest';

import { addressCandidates, applyAddress, canTakeAddress, hostAndPort } from './address-source.ts';
import { formFor } from './forms.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { ItemSummary } from '../../vault/client.ts';

const SWITCHES = { allowAnyCommand: false };

function values(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function formOf(kind: 'sql' | 'http'): ConnectorForm {
  const form = formFor(kind, SWITCHES);
  if (form === undefined) {
    throw new Error(`no ${kind} form`);
  }
  return form;
}

function item(uris: readonly string[], texts: readonly [string, string | null][]): ItemSummary {
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
    login: { username: null, uris, hasPassword: true, hasTotp: false },
    hasNotes: false,
    customFields: [
      ...texts.map(([name, value]) => ({ name, kind: 'text' as const, value })),
      { name: 'token', kind: 'hidden', value: null },
    ],
  };
}

describe('an address from the vault item', () => {
  it('ACT-2 reads the host and port an address names, however it is written', () => {
    expect(hostAndPort('https://db.example.com:1444/x')).toStrictEqual({
      host: 'db.example.com',
      port: '1444',
    });
    expect(hostAndPort('sqlserver://db:1433')).toStrictEqual({ host: 'db', port: '1433' });
    expect(hostAndPort('db.example.com:1433')).toStrictEqual({
      host: 'db.example.com',
      port: '1433',
    });
    expect(hostAndPort('10.0.0.5')).toStrictEqual({ host: '10.0.0.5' });
    expect(hostAndPort('[fd00::5]:5432')).toStrictEqual({ host: 'fd00::5', port: '5432' });
    expect(hostAndPort('https://[2001:db8::1]/')).toStrictEqual({ host: '2001:db8::1' });
    expect(hostAndPort('not a host!')).toBeUndefined();
    expect(hostAndPort('mailto:ops@example.com')).toBeUndefined();
    expect(canTakeAddress('url', 'https://api.example.com/v1')).toBe(true);
    expect(canTakeAddress('url', 'db.example.com:1433')).toBe(false);
    expect(canTakeAddress('url', 'ftp://files.example.com')).toBe(false);
    expect(canTakeAddress('host', 'reporting01')).toBe(true);
  });

  it('ACT-2 offers the login addresses, then the text fields, each once and never a hidden field', () => {
    const offered = addressCandidates(
      item(
        [' https://db.example.com ', 'https://db.example.com'],
        [
          ['host', 'db.example.com'],
          ['port', '1433'],
          ['empty', null],
        ],
      ),
    );
    expect(offered).toStrictEqual([
      { value: 'https://db.example.com', source: 'address 1' },
      { value: 'db.example.com', source: 'field host' },
      { value: '1433', source: 'field port' },
    ]);
  });

  it('ACT-2 copies the chosen address into the destination, its port with it', () => {
    const sql = formOf('sql');
    const copied = applyAddress(
      sql,
      values({ address_from: 'db.example.com:1444', 'destination.port': '1433' }),
    );
    expect(copied.problems).toStrictEqual([]);
    expect(copied.values.get('destination.host')).toBe('db.example.com');
    expect(copied.values.get('destination.port')).toBe('1444');
    const hostOnly = applyAddress(
      sql,
      values({ address_from: 'https://db.example.com/', 'destination.port': '1433' }),
    );
    expect(hostOnly.values.get('destination.port')).toBe('1433');
    const again = applyAddress(
      sql,
      values({ address_from: 'db.example.com', 'destination.host': 'db.example.com' }),
    );
    expect(again.problems).toStrictEqual([]);
    const http = applyAddress(
      formOf('http'),
      values({ address_from: 'https://api.example.com/v1' }),
    );
    expect(http.values.get('destination.base_url')).toBe('https://api.example.com/v1');
    const typed = values({ 'destination.host': 'typed.example.com' });
    expect(applyAddress(sql, typed).values).toBe(typed);
    expect(
      applyAddress({ kind: 'sql', fields: [] }, values({ address_from: 'x' })).problems,
    ).toStrictEqual([]);
  });

  it('ACT-2 refuses a choice that fits no address, and a typed address that differs from the chosen one', () => {
    expect(
      applyAddress(formOf('sql'), values({ address_from: 'not a host!' })).problems,
    ).toStrictEqual(['destination.host: the vault item\'s address "not a host!" names no host']);
    expect(
      applyAddress(formOf('http'), values({ address_from: 'db:1433' })).problems,
    ).toStrictEqual([
      'destination.base_url: the vault item\'s address "db:1433" is not an http:// or https:// URL',
    ]);
    const both = values({
      address_from: 'db.example.com',
      'destination.host': 'other.example.com',
    });
    const conflict = applyAddress(formOf('sql'), both);
    expect(conflict.values).toBe(both);
    expect(conflict.problems).toStrictEqual([
      'destination.host: an address is typed here and another is taken from the vault item; keep one of them',
    ]);
  });
});
