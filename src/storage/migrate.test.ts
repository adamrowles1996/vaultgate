import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { migrate, MigrationError } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { all } from './query.ts';

const NOW = new Date('2026-09-22T10:00:00Z');
const nameSchema = z.object({ name: z.string() });
const versionSchema = z.object({ version: z.number() });
const registrySchema = z.object({
  version: z.number(),
  applied_at: z.number(),
  checksum: z.string(),
});

const first = { version: 1, name: 'first', sql: 'CREATE TABLE first (id INTEGER)' };
const second = { version: 2, name: 'second', sql: 'CREATE TABLE second (id INTEGER)' };

function tables(database: DatabaseSync): string[] {
  return all(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    nameSchema,
  ).map((row) => row.name);
}

function indexes(database: DatabaseSync): string[] {
  return all(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
    nameSchema,
  ).map((row) => row.name);
}

describe('migrate', () => {
  it('STORE-3 applies every migration on an empty database and records each checksum', () => {
    const database = new DatabaseSync(':memory:');
    const report = unwrapOk(migrate(database, [first, second], NOW));
    expect(report).toStrictEqual({ applied: [1, 2], version: 2 });
    expect(tables(database)).toStrictEqual(['first', 'schema_migrations', 'second']);
    const rows = all(database, 'SELECT * FROM schema_migrations ORDER BY version', registrySchema);
    expect(rows.map((row) => row.version)).toStrictEqual([1, 2]);
    expect(rows.map((row) => row.applied_at)).toStrictEqual([NOW.getTime(), NOW.getTime()]);
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.checksum).not.toBe(rows[1]?.checksum);
  });

  it('STORE-3 is a no-op when re-run and applies only what is pending', () => {
    const database = new DatabaseSync(':memory:');
    unwrapOk(migrate(database, [first], NOW));
    expect(unwrapOk(migrate(database, [first], NOW))).toStrictEqual({ applied: [], version: 1 });
    expect(unwrapOk(migrate(database, [first, second], NOW))).toStrictEqual({
      applied: [2],
      version: 2,
    });
    expect(tables(database)).toStrictEqual(['first', 'schema_migrations', 'second']);
  });

  it('STORE-3 rolls a failing migration back as one transaction', () => {
    const database = new DatabaseSync(':memory:');
    const broken = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE partial (id INTEGER); CREATE TABLE first (id INTEGER)',
    };
    expect(() => migrate(database, [first, broken], NOW)).toThrow(/already exists/);
    expect(database.isTransaction).toBe(false);
    expect(tables(database)).toStrictEqual(['first', 'schema_migrations']);
    expect(all(database, 'SELECT version FROM schema_migrations', versionSchema)).toStrictEqual([
      { version: 1 },
    ]);
  });

  it('STORE-3 refuses to start when an applied migration has changed', () => {
    const database = new DatabaseSync(':memory:');
    unwrapOk(migrate(database, [first], NOW));
    const edited = { ...first, sql: 'CREATE TABLE first (id INTEGER, extra TEXT)' };
    const error = unwrapFail(migrate(database, [edited], NOW));
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.name).toBe('MigrationError');
    expect(error.message).toMatch(/migration 1 \(first\) has changed since it was applied/);
  });

  it('OPS-8 refuses to start against a database with a version this build does not know', () => {
    const database = new DatabaseSync(':memory:');
    unwrapOk(migrate(database, [first, second], NOW));
    const error = unwrapFail(migrate(database, [first], NOW));
    expect(error.message).toBe(
      'database is at schema version 2, which this build does not know; refusing to start against a newer database',
    );
    expect(tables(database)).toStrictEqual(['first', 'schema_migrations', 'second']);
  });

  it('refuses a registry that is not contiguous from 1', () => {
    const database = new DatabaseSync(':memory:');
    const error = unwrapFail(migrate(database, [first, { ...second, version: 3 }], NOW));
    expect(error.message).toBe(
      'migration registry is not contiguous from 1: entry 1 has version 3',
    );
    expect(tables(database)).toStrictEqual(['schema_migrations']);
  });

  it('refuses a schema_migrations table that is not contiguous from 1', () => {
    const database = new DatabaseSync(':memory:');
    unwrapOk(migrate(database, [first], NOW));
    database.exec('UPDATE schema_migrations SET version = 5');
    const error = unwrapFail(migrate(database, [first], NOW));
    expect(error.message).toBe('schema_migrations is not contiguous from 1: row 0 has version 5');
  });

  it('STORE-5 creates the v1 schema with every table and hot-path index', () => {
    const database = new DatabaseSync(':memory:');
    expect(unwrapOk(migrate(database, MIGRATIONS, NOW))).toStrictEqual({
      applied: [1],
      version: 1,
    });
    expect(tables(database)).toStrictEqual([
      'audit_events',
      'authorization_codes',
      'bootstrap_tokens',
      'cimd_cache',
      'consents',
      'login_attempts',
      'oauth_clients',
      'operators',
      'pending_authorizations',
      'recovery_codes',
      'schema_migrations',
      'sessions',
      'tokens',
    ]);
    expect(indexes(database)).toStrictEqual([
      'idx_audit_events_at',
      'idx_audit_events_client_id_at',
      'idx_audit_events_operator_id_at',
      'idx_authorization_codes_expires_at',
      'idx_cimd_cache_expires_at',
      'idx_consents_operator_id_client_id',
      'idx_login_attempts_subject_attempted_at',
      'idx_pending_authorizations_expires_at',
      'idx_recovery_codes_operator_id',
      'idx_sessions_expires_at',
      'idx_sessions_operator_id',
      'idx_tokens_consent_id',
      'idx_tokens_expires_at',
      'idx_tokens_family_id',
    ]);
    const unique = all(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%' ORDER BY name",
      nameSchema,
    );
    expect(unique.map((row) => row.name)).toContain('sqlite_autoindex_tokens_2');
    expect(unique.map((row) => row.name)).toContain('sqlite_autoindex_sessions_1');
    expect(unique.map((row) => row.name)).toContain('sqlite_autoindex_authorization_codes_1');
  });
});
