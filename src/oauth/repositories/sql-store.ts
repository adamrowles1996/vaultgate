import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

export type SqlValue = string | number | null;
export type Row = Record<string, SQLOutputValue>;
type Cell = SQLOutputValue | undefined;

/**
 * The narrow view of the database the repositories use. The storage layer
 * owns the connection, migrations and retention; this interface keeps the
 * repositories testable against an in-memory database.
 */
export interface SqlStore {
  /**
  Executes a statement and returns the number of rows changed.
  */
  run(sql: string, ...parameters: SqlValue[]): number;
  get(sql: string, ...parameters: SqlValue[]): Row | undefined;
  all(sql: string, ...parameters: SqlValue[]): Row[];
  transaction<T>(work: () => T): T;
}

export function createSqlStore(database: DatabaseSync): SqlStore {
  return {
    run(sql, ...parameters) {
      return Number(database.prepare(sql).run(...parameters).changes);
    },
    get(sql, ...parameters) {
      return database.prepare(sql).get(...parameters);
    },
    all(sql, ...parameters) {
      return database.prepare(sql).all(...parameters);
    },
    transaction(work) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function parseJsonArray(text: Cell): readonly string[] {
  const value: unknown = JSON.parse(String(text));
  return Array.isArray(value) ? value.map(String) : [];
}

export function optionalNumber(value: Cell): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

export function optionalString(value: Cell): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
