import { createHash } from 'node:crypto';

import { z } from 'zod';

import { fail, ok, type Result } from '../result.ts';

import { all, run, transaction } from './query.ts';

import type { Migration } from './migrations/index.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface MigrationReport {
  /**
  Versions this call applied, ascending; empty when the schema was already current.
  */
  readonly applied: readonly number[];
  /**
  The schema version after this call.
  */
  readonly version: number;
}

/**
A fatal start-up condition: the database and this build disagree about the schema (STORE-3, OPS-8).
*/
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const appliedRowSchema = z.object({ version: z.number().int(), checksum: z.string() });
type AppliedRow = z.output<typeof appliedRowSchema>;

const CREATE_REGISTRY = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
)`;

function checksumOf(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

/**
The registry must be dense and ascending from 1 so "version N" has one meaning everywhere.
*/
function registryProblem(migrations: readonly Migration[]): string | undefined {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      return `migration registry is not contiguous from 1: entry ${index} has version ${migration.version}`;
    }
  }
  return undefined;
}

function appliedProblem(
  rows: readonly AppliedRow[],
  migrations: readonly Migration[],
): string | undefined {
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) {
      return `schema_migrations is not contiguous from 1: row ${index} has version ${row.version}`;
    }
    const known = migrations[index];
    if (known === undefined) {
      return `database is at schema version ${row.version}, which this build does not know; refusing to start against a newer database`;
    }
    if (checksumOf(known) !== row.checksum) {
      return `migration ${row.version} (${known.name}) has changed since it was applied; expected checksum ${row.checksum}`;
    }
  }
  return undefined;
}

function apply(database: DatabaseSync, migration: Migration, appliedAt: number): void {
  transaction(database, () => {
    database.exec(migration.sql);
    run(
      database,
      'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
      migration.version,
      appliedAt,
      checksumOf(migration),
    );
  });
}

/**
 * Brings the database forward to the newest version in `migrations`, one
 * transaction per migration. Re-running is a no-op. Refuses to proceed when
 * an applied migration's SQL has changed or the database knows a version this
 * build does not.
 */
export function migrate(
  database: DatabaseSync,
  migrations: readonly Migration[],
  now: Date,
): Result<MigrationReport, MigrationError> {
  database.exec(CREATE_REGISTRY);
  const rows = all(
    database,
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
    appliedRowSchema,
  );
  const problem = registryProblem(migrations) ?? appliedProblem(rows, migrations);
  if (problem !== undefined) {
    return fail(new MigrationError(problem));
  }
  const pending = migrations.slice(rows.length);
  for (const migration of pending) {
    apply(database, migration, now.getTime());
  }
  return ok({ applied: pending.map((migration) => migration.version), version: migrations.length });
}
