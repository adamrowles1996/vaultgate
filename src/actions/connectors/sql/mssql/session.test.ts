import { describe, expect, it } from 'vitest';

import {
  codedError as coded,
  fakeMssqlPool as fakePool,
  mssqlDriverOf as driverOf,
  sqlConnection,
} from '../../../../test-support/fake-sql-drivers.ts';
import { rejection } from '../../../../test-support/fake-sql-session.ts';

import { configOf, loadMssqlDriver, mssqlSession, openMssqlSession } from './session.ts';

import type { SqlConnection } from '../session.ts';

function connection(overrides: Partial<SqlConnection> = {}): SqlConnection {
  return sqlConnection({ port: 1433, ...overrides });
}

describe('the SQL Server connection configuration', () => {
  it('ACT-55 connects to the pinned address and keeps the host name for TLS only', () => {
    expect(configOf(connection())).toStrictEqual({
      server: '93.184.216.34',
      port: 1433,
      database: 'reporting',
      user: 'reader',
      password: 'canary-secret',
      connectionTimeout: 30_000,
      requestTimeout: 15_000,
      pool: { max: 1, min: 0 },
      options: {
        serverName: 'db.example.com',
        encrypt: true,
        trustServerCertificate: false,
      },
    });
  });

  it('ACT-57 verify-full verifies against the certificate authority the destination carries', () => {
    expect(configOf(connection({ tls: 'verify-full', caPem: '-----BEGIN' })).options).toMatchObject(
      { cryptoCredentialsDetails: { ca: '-----BEGIN' } },
    );
  });

  it('ACT-57 disable turns encryption off, which only an internal target may ask for', () => {
    expect(configOf(connection({ tls: 'disable' })).options.encrypt).toBe(false);
  });
});

describe('the SQL Server session', () => {
  it('ACT-23 ACT-24 binds @pn parameters and returns the columns with their type names', async () => {
    const pool = fakePool();
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({
      text: 'SELECT id, total FROM t WHERE id = @p1',
      params: ['a'],
      maxRows: 2,
    });
    await session.close();
    expect(pool.inputs).toStrictEqual([['p1', 'a']]);
    expect(pool.commands).toStrictEqual(['SELECT id, total FROM t WHERE id = @p1']);
    expect(rows).toStrictEqual({
      columns: [
        { name: 'id', type: 'int' },
        { name: 'total', type: 'decimal' },
      ],
      rows: [
        [1, '12.5'],
        [2, null],
      ],
      rowsAffected: 3,
    });
    expect(pool.closed).toStrictEqual([1]);
  });

  it('ACT-24 a statement that returns nothing has no columns and no rows', async () => {
    const pool = fakePool({
      answers: { columns: undefined, recordset: undefined, rowsAffected: [] },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT 1', params: [], maxRows: 1 });
    await session.close();
    expect(rows).toStrictEqual({ columns: [], rows: [], rowsAffected: 0 });
  });

  it('ACT-24 a value in a column the metadata does not name is still a scalar', async () => {
    const pool = fakePool({ answers: { columns: [[]], recordset: [[7]], rowsAffected: [1] } });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT 1', params: [], maxRows: 1 });
    await session.close();
    expect(rows.rows).toStrictEqual([[7]]);
  });

  it('ACT-74 the server refusing the login is authentication_failed and the pool is closed', async () => {
    const pool = fakePool({ connectError: coded('Login failed', 'ELOGIN') });
    const failure = await rejection(openMssqlSession(driverOf(pool), connection()));
    expect(failure.code).toBe('authentication_failed');
    expect(pool.closed).toStrictEqual([0]);
  });

  it('ACT-74 a socket failure is connection_failed and a request timeout is timeout', async () => {
    const refused = fakePool({ connectError: coded('socket', 'ESOCKET') });
    const socket = await rejection(openMssqlSession(driverOf(refused), connection()));
    expect(socket.code).toBe('connection_failed');
    const pool = fakePool({ queryError: coded('timed out', 'ETIMEOUT') });
    const session = await openMssqlSession(driverOf(pool), connection());
    const timedOut = await rejection(session.query({ text: 'SELECT 1', params: [], maxRows: 1 }));
    await session.close();
    expect(timedOut.code).toBe('timeout');
  });

  it('ACT-74 a SQL error raised after sign-in is upstream_error with the server message', async () => {
    const pool = fakePool({ queryError: coded("Invalid column name 'x'", 'EREQUEST') });
    const session = await openMssqlSession(driverOf(pool), connection());
    const failure = await rejection(session.query({ text: 'SELECT x', params: [], maxRows: 1 }));
    await session.close();
    expect(failure.code).toBe('upstream_error');
    expect(failure.detail).toStrictEqual({ message: "Invalid column name 'x'" });
  });

  it('ACT-59 an abort cancels the running statement and closes the pool, and close stops listening', async () => {
    const controller = new AbortController();
    const pool = fakePool();
    const session = await openMssqlSession(
      driverOf(pool),
      connection({ signal: controller.signal }),
    );
    const pending = session.query({ text: 'SELECT 1', params: [], maxRows: 1 });
    controller.abort();
    await pending;
    expect(pool.cancelled).toStrictEqual([1]);
    expect(pool.closed).toStrictEqual([1]);
    await session.close();
    expect(pool.closed).toStrictEqual([1, 1]);
  });

  it('ACT-59 an abort with no statement running still closes the pool', async () => {
    const controller = new AbortController();
    const pool = fakePool();
    await openMssqlSession(driverOf(pool), connection({ signal: controller.signal }));
    controller.abort();
    expect(pool.cancelled).toStrictEqual([]);
    expect(pool.closed).toStrictEqual([0]);
  });

  it('ACT-25 a write runs inside the driver transaction and commits when the statement succeeds', async () => {
    const pool = fakePool();
    const session = await openMssqlSession(driverOf(pool), connection({ mode: 'write' }));
    const rows = await session.query({
      text: 'UPDATE t SET a = @p1 OUTPUT inserted.id',
      params: [1],
      maxRows: 10,
    });
    await session.close();
    expect(pool.steps).toStrictEqual(['begin', 'commit']);
    expect(pool.inputs).toStrictEqual([['p1', 1]]);
    expect(rows.rowsAffected).toBe(3);
  });

  it('ACT-25 a write that fails rolls back and answers the mapped code', async () => {
    const pool = fakePool({ queryError: coded('constraint', 'EREQUEST') });
    const session = await openMssqlSession(driverOf(pool), connection({ mode: 'write' }));
    const failure = await rejection(
      session.query({ text: 'DELETE FROM t', params: [], maxRows: 1 }),
    );
    await session.close();
    expect(pool.steps).toStrictEqual(['begin', 'rollback']);
    expect(failure.code).toBe('upstream_error');
  });

  it('ACT-25 a rollback that also fails never replaces the original code', async () => {
    const pool = fakePool({
      queryError: coded('constraint', 'EREQUEST'),
      rollbackError: new Error('connection gone'),
    });
    const session = await openMssqlSession(driverOf(pool), connection({ mode: 'write' }));
    const failure = await rejection(
      session.query({ text: 'DELETE FROM t', params: [], maxRows: 1 }),
    );
    await session.close();
    expect(failure.code).toBe('upstream_error');
  });

  it('ACT-59 an abort cancels the statement of a write as well', async () => {
    const controller = new AbortController();
    const pool = fakePool();
    const session = await openMssqlSession(
      driverOf(pool),
      connection({ mode: 'write', signal: controller.signal }),
    );
    const pending = session.query({ text: 'DELETE FROM t', params: [], maxRows: 1 });
    controller.abort();
    await pending;
    // The abort arrives while BEGIN is still in flight, so the statement is cancelled the
    // moment the transaction hands it over, before it has issued anything.
    expect(pool.cancelled).toStrictEqual([0]);
    expect(pool.closed).toStrictEqual([0]);
  });

  it('ACT-73 ACT-84 the mssql driver is loaded on demand and builds a pool that has not connected', async () => {
    const driver = await loadMssqlDriver();
    const real = driver(configOf(connection()));
    expect(real.request).toBeTypeOf('function');
    const pool = fakePool();
    const session = await mssqlSession(connection(), () => Promise.resolve(driverOf(pool)));
    await session.close();
    expect(pool.closed).toStrictEqual([0]);
  });
});
