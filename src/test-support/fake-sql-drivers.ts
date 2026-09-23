/**
 * The fake `pg` client and `mssql` pool the two session modules are tested
 * against (ACT-78): every session behaviour — the transaction each mode
 * opens, the type lookup, the cancellation on abort, every driver failure —
 * is proven without a database. The driver classes themselves are injected,
 * so these fakes stand exactly where the real ones do.
 */
import type { MssqlDriver, MssqlPool } from '../actions/connectors/sql/mssql/session.ts';
import type { PostgresClient, PostgresDriver } from '../actions/connectors/sql/postgres/session.ts';
import type { SqlConnection } from '../actions/connectors/sql/session.ts';

export interface DriverOptions {
  /**
  Merged into the result every statement answers with.
  */
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly connectError?: Error;
  readonly queryError?: Error;
  readonly rollbackError?: Error;
  /**
  The statement prefixes `queryError` applies to; `SELECT` unless told otherwise.
  */
  readonly failOn?: readonly string[];
}

/**
An error carrying the `code` a driver hangs on its failures.
*/
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function sqlConnection(overrides: Partial<SqlConnection> = {}): SqlConnection {
  return {
    host: 'db.example.com',
    address: '93.184.216.34',
    port: 5432,
    database: 'reporting',
    username: 'reader',
    password: 'canary-secret',
    tls: 'require',
    caPem: undefined,
    mode: 'read',
    connectTimeoutMs: 30_000,
    statementTimeoutMs: 15_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

export interface FakeClient extends PostgresClient {
  readonly queries: Recorded[];
  readonly ended: number[];
}

const TYPE_ROWS = {
  rows: [
    [23, 'int4'],
    [25, 'text'],
  ],
  fields: [],
  rowCount: 2,
};

const PG_RESULT = {
  fields: [
    { name: 'id', dataTypeID: 23 },
    { name: 'note', dataTypeID: 9999 },
  ],
  rows: [
    [1, 'a'],
    [2, 'b'],
    [3, 'c'],
  ],
  rowCount: 3,
};

export function fakePostgresClient(options: DriverOptions = {}): FakeClient {
  const queries: Recorded[] = [];
  const ended: number[] = [];
  return {
    queries,
    ended,
    connect: () =>
      options.connectError === undefined
        ? Promise.resolve(undefined)
        : Promise.reject(options.connectError),
    query(query) {
      queries.push({ text: query.text, values: query.values });
      const failing = options.failOn ?? ['SELECT'];
      if (options.queryError !== undefined && failing.some((on) => query.text.startsWith(on))) {
        return Promise.reject(options.queryError);
      }
      return query.text.startsWith('SELECT oid')
        ? Promise.resolve(TYPE_ROWS)
        : Promise.resolve({ ...PG_RESULT, ...options.answers });
    },
    end() {
      ended.push(queries.length);
      return Promise.resolve();
    },
  };
}

export function postgresDriverOf(client: PostgresClient): PostgresDriver {
  return () => client;
}

export interface FakePool extends MssqlPool {
  readonly commands: string[];
  readonly inputs: [string, unknown][];
  readonly closed: number[];
  readonly cancelled: number[];
  /**
  Every step of the driver's own transaction, in order: begin, commit, rollback.
  */
  readonly steps: string[];
}

const MSSQL_RESULT = {
  columns: [
    [
      { name: 'id', type: { declaration: 'int' } },
      { name: 'total', type: { declaration: 'decimal' } },
    ],
  ],
  recordset: [
    [1, 12.5],
    [2, null],
    [3, 9],
  ],
  rowsAffected: [3],
};

export function fakeMssqlPool(options: DriverOptions = {}): FakePool {
  const commands: string[] = [];
  const inputs: [string, unknown][] = [];
  const closed: number[] = [];
  const cancelled: number[] = [];
  const steps: string[] = [];
  const request = (): ReturnType<MssqlPool['request']> => ({
    arrayRowMode: false,
    input(name, value) {
      inputs.push([name, value]);
    },
    query(command) {
      commands.push(command);
      return options.queryError === undefined
        ? Promise.resolve({ ...MSSQL_RESULT, ...options.answers })
        : Promise.reject(options.queryError);
    },
    cancel() {
      cancelled.push(commands.length);
    },
  });
  const step = (name: string): Promise<unknown> => {
    steps.push(name);
    return name === 'rollback' && options.rollbackError !== undefined
      ? Promise.reject(options.rollbackError)
      : Promise.resolve(undefined);
  };
  return {
    commands,
    inputs,
    closed,
    cancelled,
    steps,
    connect: () =>
      options.connectError === undefined
        ? Promise.resolve(undefined)
        : Promise.reject(options.connectError),
    request,
    transaction: () => ({
      begin: () => step('begin'),
      commit: () => step('commit'),
      rollback: () => step('rollback'),
      request,
    }),
    close() {
      closed.push(commands.length);
      return Promise.resolve();
    },
  };
}

export function mssqlDriverOf(pool: MssqlPool): MssqlDriver {
  return () => pool;
}
