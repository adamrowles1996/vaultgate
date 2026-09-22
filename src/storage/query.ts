import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';

export type Parameters = readonly SQLInputValue[];

/**
 * A row shape as a zod schema. Rows come back from `node:sqlite` untyped, so
 * repositories declare what they expect and every row is checked on the way
 * out rather than cast; a schema drift then fails loudly at the query.
 */
export type RowSchema<T> = z.ZodType<T>;

/**
Executes a statement that returns no rows and yields the number of rows changed.
*/
export function run(database: DatabaseSync, sql: string, ...parameters: Parameters): number {
  return Number(database.prepare(sql).run(...parameters).changes);
}

/**
Executes a query and yields its first row, or `undefined` when there is none.
*/
export function get<T>(
  database: DatabaseSync,
  sql: string,
  schema: RowSchema<T>,
  ...parameters: Parameters
): T | undefined {
  const row = database.prepare(sql).get(...parameters);
  return row === undefined ? undefined : schema.parse(row);
}

/**
Executes a query and yields every row.
*/
export function all<T>(
  database: DatabaseSync,
  sql: string,
  schema: RowSchema<T>,
  ...parameters: Parameters
): T[] {
  return database
    .prepare(sql)
    .all(...parameters)
    .map((row) => schema.parse(row));
}

/**
 * Runs `work` inside one transaction: committed when it returns, rolled back
 * when it throws. The exception is rethrown after the rollback.
 */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
