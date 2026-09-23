import { describe, expect, it } from 'vitest';

import { rejection } from '../../../../test-support/fake-sql-session.ts';

import { configOf, loadPostgresDriver, openPostgresSession, postgresSession } from './session.ts';

import type { PostgresClient, PostgresDriver } from './session.ts';
import type { SqlConnection } from '../session.ts';

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakeClient extends PostgresClient {
  readonly queries: Recorded[];
  readonly ended: number[];
}

interface FakeOptions {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly connectError?: Error;
  readonly queryError?: Error;
  readonly failOn?: readonly string[];
}

const TYPE_ROWS = {
  rows: [
    [23, 'int4'],
    [25, 'text'],
  ],
  fields: [],
  rowCount: 2,
};

const RESULT = {
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

function fakeClient(options: FakeOptions = {}): FakeClient {
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
        : Promise.resolve({ ...RESULT, ...options.answers });
    },
    end() {
      ended.push(queries.length);
      return Promise.resolve();
    },
  };
}

function connection(overrides: Partial<SqlConnection> = {}): SqlConnection {
  return {
    host: 'db.example.com',
    address: '93.184.216.34',
    port: 5432,
    database: 'reporting',
    username: 'reader',
    password: 'canary-secret',
    tls: 'require',
    caPem: undefined,
    readOnly: true,
    connectTimeoutMs: 30_000,
    statementTimeoutMs: 15_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function driverOf(client: PostgresClient): PostgresDriver {
  return () => client;
}

describe('the postgres client configuration', () => {
  it('ACT-55 connects to the pinned address and keeps the host name for TLS only', () => {
    expect(configOf(connection())).toStrictEqual({
      host: '93.184.216.34',
      port: 5432,
      database: 'reporting',
      user: 'reader',
      password: 'canary-secret',
      ssl: { servername: 'db.example.com', rejectUnauthorized: true },
      statement_timeout: 15_000,
      connectionTimeoutMillis: 30_000,
      application_name: 'vaultgate',
    });
  });

  it('ACT-57 verify-full verifies against the certificate authority the destination carries', () => {
    expect(configOf(connection({ tls: 'verify-full', caPem: '-----BEGIN' })).ssl).toStrictEqual({
      servername: 'db.example.com',
      rejectUnauthorized: true,
      ca: '-----BEGIN',
    });
  });

  it('ACT-57 disable is plain transport, which only an internal target may ask for', () => {
    expect(configOf(connection({ tls: 'disable' })).ssl).toBe(false);
  });
});

describe('the postgres session', () => {
  it('ACT-85 opens the session read-only and wraps the statement in a read-only transaction', async () => {
    const client = fakeClient();
    const session = await openPostgresSession(driverOf(client), connection());
    await session.query({ text: 'SELECT id, note FROM t WHERE id = $1', params: [1], maxRows: 2 });
    await session.close();
    expect(client.queries.map((query) => query.text)).toStrictEqual([
      'SET default_transaction_read_only = on',
      'BEGIN READ ONLY',
      'SELECT id, note FROM t WHERE id = $1',
      'SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
      'COMMIT',
    ]);
    expect(client.queries[2]?.values).toStrictEqual([1]);
    expect(client.ended).toStrictEqual([5]);
  });

  it('ACT-24 names each column with the type the database gives it, and falls back to the oid', async () => {
    const client = fakeClient();
    const session = await openPostgresSession(driverOf(client), connection());
    const rows = await session.query({ text: 'SELECT id, note FROM t', params: [], maxRows: 2 });
    await session.close();
    expect(rows).toStrictEqual({
      columns: [
        { name: 'id', type: 'int4' },
        { name: 'note', type: 'oid:9999' },
      ],
      rows: [
        [1, 'a'],
        [2, 'b'],
      ],
      rowsAffected: 3,
    });
  });

  it('ACT-24 a result with no columns needs no type lookup', async () => {
    const client = fakeClient({ answers: { fields: [], rows: [], rowCount: 0 } });
    const session = await openPostgresSession(driverOf(client), connection());
    const rows = await session.query({ text: 'SELECT 1', params: [], maxRows: 2 });
    await session.close();
    expect(rows).toStrictEqual({ columns: [], rows: [], rowsAffected: 0 });
    expect(client.queries.map((query) => query.text)).not.toContain(
      'SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
    );
  });

  it('ACT-85 a session that is not read-only opens no transaction of its own', async () => {
    const client = fakeClient();
    const session = await openPostgresSession(driverOf(client), connection({ readOnly: false }));
    await session.query({ text: 'SELECT 1', params: [], maxRows: 1 });
    await session.close();
    expect(client.queries.map((query) => query.text)).not.toContain('BEGIN READ ONLY');
  });

  it('ACT-74 a statement that fails rolls back and answers the mapped code', async () => {
    const client = fakeClient({ queryError: coded('cancelled', '57014') });
    const session = await openPostgresSession(driverOf(client), connection());
    const failure = await rejection(session.query({ text: 'SELECT 1', params: [], maxRows: 1 }));
    await session.close();
    expect(failure.code).toBe('timeout');
    expect(client.queries.map((query) => query.text)).toContain('ROLLBACK');
  });

  it('ACT-74 a rollback that also fails never replaces the original code', async () => {
    const client = fakeClient({
      queryError: coded('boom', '42601'),
      failOn: ['SELECT id', 'SELECT 1', 'ROLLBACK'],
    });
    const session = await openPostgresSession(driverOf(client), connection());
    const failure = await rejection(session.query({ text: 'SELECT 1', params: [], maxRows: 1 }));
    await session.close();
    expect(failure.code).toBe('upstream_error');
  });

  it('ACT-74 the server refusing the login is authentication_failed and the client is closed', async () => {
    const client = fakeClient({ connectError: coded('password authentication failed', '28P01') });
    const failure = await rejection(openPostgresSession(driverOf(client), connection()));
    expect(failure.code).toBe('authentication_failed');
    expect(client.ended).toStrictEqual([0]);
  });

  it('ACT-74 a refused socket is connection_failed', async () => {
    const client = fakeClient({ connectError: coded('connect', 'ECONNREFUSED') });
    const failure = await rejection(openPostgresSession(driverOf(client), connection()));
    expect(failure.code).toBe('connection_failed');
  });

  it('ACT-57 a certificate the client will not accept is tls_error', async () => {
    const client = fakeClient({ connectError: coded('expired', 'CERT_HAS_EXPIRED') });
    const failure = await rejection(openPostgresSession(driverOf(client), connection()));
    expect(failure.code).toBe('tls_error');
  });

  it('ACT-59 an abort closes the client, and closing afterwards stops listening', async () => {
    const controller = new AbortController();
    const client = fakeClient();
    const session = await openPostgresSession(
      driverOf(client),
      connection({ signal: controller.signal }),
    );
    controller.abort();
    expect(client.ended).toStrictEqual([1]);
    await session.close();
    expect(client.ended).toStrictEqual([1, 1]);
  });

  it('ACT-24 a statement the server reports no row count for is zero rows affected', async () => {
    const client = fakeClient({ answers: { fields: [], rows: [], rowCount: null } });
    const session = await openPostgresSession(driverOf(client), connection());
    const rows = await session.query({ text: 'SELECT 1', params: [], maxRows: 1 });
    await session.close();
    expect(rows.rowsAffected).toBe(0);
  });

  it('ACT-73 ACT-84 the pg driver is loaded on demand and builds a client that has not connected', async () => {
    const driver = await loadPostgresDriver();
    const real = driver(configOf(connection()));
    expect(real.query).toBeTypeOf('function');
    const client = fakeClient();
    const session = await postgresSession(connection(), () => Promise.resolve(driverOf(client)));
    await session.close();
    expect(client.ended).toStrictEqual([1]);
  });
});
