import { createOAuthRepos, type OAuthRepos } from '../oauth/repositories/index.ts';
import { IN_MEMORY, openDatabase } from '../storage/database.ts';
import { migrate } from '../storage/migrate.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';
import { run } from '../storage/query.ts';

import { unwrapOk } from './result.ts';

export const TEST_OPERATOR_ID = 'operator-1';

/**
 * An in-memory database at the current schema with one operator, enough for
 * the OAuth repositories and endpoints.
 */
export function openTestRepos(): OAuthRepos {
  const database = openDatabase({ path: IN_MEMORY, networkFs: false });
  unwrapOk(migrate(database, MIGRATIONS, new Date(0)));
  run(
    database,
    `INSERT INTO operators (id, display_name, password_hash, created_at, password_changed_at)
     VALUES (?, ?, ?, ?, ?)`,
    TEST_OPERATOR_ID,
    'Operator',
    'hash',
    0,
    0,
  );
  return createOAuthRepos(database);
}
