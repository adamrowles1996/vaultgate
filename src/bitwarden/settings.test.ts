import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../test-support/database.ts';
import { sequentialRandom } from '../test-support/identity.ts';

import { createVaultSettings, type VaultSettings } from './settings.ts';

import type { DatabaseSync } from 'node:sqlite';

const KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 8);
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const VALUES = {
  clientId: 'user.first',
  clientSecret: 'CANARY-FIRST-CLIENT-SECRET',
  masterPassword: 'CANARY-FIRST-MASTER-PASSWORD',
  server: undefined,
};
const OTHER_VALUES = {
  clientId: 'user.second',
  clientSecret: 'CANARY-SECOND-CLIENT-SECRET',
  masterPassword: 'CANARY-SECOND-MASTER-PASSWORD',
  server: 'https://vault.example.test',
};

function settingsOver(database: DatabaseSync, key = KEY): VaultSettings {
  return createVaultSettings({ database, secretKey: key, random: sequentialRandom() });
}

function rawRow(database: DatabaseSync): Record<string, unknown> {
  return database.prepare('SELECT * FROM vault_settings').get() as Record<string, unknown>;
}

describe('createVaultSettings', () => {
  it('STORE-9 loads nothing from an empty store', () => {
    expect(settingsOver(openTestDatabase()).load()).toStrictEqual({ kind: 'none' });
  });

  it('STORE-9 STORE-4 round-trips a connection while storing only ciphertext', () => {
    const database = openTestDatabase();
    const settings = settingsOver(database);
    expect(settings.save(VALUES, 'operator-1', NOW)).toBeUndefined();
    expect(settings.load()).toStrictEqual({ kind: 'ok', values: VALUES, updatedAt: NOW });
    const row = rawRow(database);
    const stored = JSON.stringify(row);
    expect(row).toMatchObject({
      id: 1,
      server_url: null,
      client_id: 'user.first',
      updated_at: NOW,
      updated_by: 'operator-1',
    });
    expect(String(row['client_secret_ciphertext'])).toMatch(/^v1\./);
    expect(String(row['master_password_ciphertext'])).toMatch(/^v1\./);
    expect(stored).not.toContain(VALUES.clientSecret);
    expect(stored).not.toContain(VALUES.masterPassword);
    expect(row['client_secret_ciphertext']).not.toBe(row['master_password_ciphertext']);
  });

  it('STORE-9 replaces the single row, hands back what it replaced, and restores it', () => {
    const database = openTestDatabase();
    const settings = settingsOver(database);
    settings.save(VALUES, 'operator-1', NOW);
    const previous = settings.save(OTHER_VALUES, 'operator-1', NOW + 1);
    expect(previous).toMatchObject({ clientId: 'user.first', updatedAt: NOW });
    expect(settings.load()).toStrictEqual({
      kind: 'ok',
      values: OTHER_VALUES,
      updatedAt: NOW + 1,
    });
    expect(rawRow(database)['server_url']).toBe('https://vault.example.test');
    settings.restore(previous);
    expect(settings.load()).toStrictEqual({ kind: 'ok', values: VALUES, updatedAt: NOW });
    settings.restore(undefined);
    expect(settings.load()).toStrictEqual({ kind: 'none' });
  });

  it('STORE-8 reports a row sealed under another key as undecryptable rather than wrong', () => {
    const database = openTestDatabase();
    settingsOver(database).save(VALUES, 'operator-1', NOW);
    expect(settingsOver(database, OTHER_KEY).load()).toStrictEqual({ kind: 'undecryptable' });
    database.exec("UPDATE vault_settings SET master_password_ciphertext = 'v1.garbage'");
    expect(settingsOver(database).load()).toStrictEqual({ kind: 'undecryptable' });
  });
});
