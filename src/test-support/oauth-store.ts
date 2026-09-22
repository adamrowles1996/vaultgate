import { DatabaseSync } from 'node:sqlite';

import { createOAuthRepos, type OAuthRepos } from '../oauth/repositories/index.ts';
import { createSqlStore } from '../oauth/repositories/sql-store.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';

export const TEST_OPERATOR_ID = 'operator-1';

/**
 * An in-memory database at the current schema with one operator, enough for
 * the OAuth repositories and endpoints.
 */
export function openTestRepos(): OAuthRepos {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    database.exec(migration.sql);
  }
  database
    .prepare(
      `INSERT INTO operators (id, display_name, password_hash, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(TEST_OPERATOR_ID, 'Operator', 'hash', 0, 0);
  return createOAuthRepos(createSqlStore(database));
}
