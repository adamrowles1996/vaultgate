import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../storage/migrate.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';

import { unwrapOk } from './result.ts';

/**
An in-memory database at the current schema, with foreign keys enforced as in production.
*/
export function openTestDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  unwrapOk(migrate(database, MIGRATIONS, new Date(0)));
  return database;
}
