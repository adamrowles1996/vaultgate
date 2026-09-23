import { describe, expect, it } from 'vitest';

import {
  codedError as coded,
  fakePostgresClient as fakeClient,
  postgresDriverOf as driverOf,
  sqlConnection as connection,
} from '../../../../test-support/fake-sql-drivers.ts';
import { rejection } from '../../../../test-support/fake-sql-session.ts';

import {
  configOf,
  loadPostgresDriver,
  openPostgresSession,
  postgresDriverFrom,
  postgresSession,
} from './session.ts';

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

  /**
   * The regression test for the shipped defect: a target reached by address
   * carried its own host into `servername`, and Node refuses an IP literal as
   * SNI, so the call never reached the handshake.
   */
  it('ACT-55 ACT-57 an IP-literal host is verified as an address, with no server name', () => {
    expect(configOf(connection({ host: '93.184.216.34' })).ssl).toStrictEqual({
      host: '93.184.216.34',
      rejectUnauthorized: true,
    });
  });

  it('ACT-55 ACT-57 an IPv6-literal host is verified as an address too', () => {
    expect(configOf(connection({ host: '2606:2800:220:1:248:1893:25c8:1946' })).ssl).toStrictEqual({
      host: '93.184.216.34',
      rejectUnauthorized: true,
    });
  });

  it('ACT-55 ACT-57 a name-based host keeps the server name for SNI', () => {
    expect(configOf(connection()).ssl).toStrictEqual({
      servername: 'db.example.com',
      rejectUnauthorized: true,
    });
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

  it('ACT-25 a write session opens an ordinary transaction and commits, never setting the session read-only', async () => {
    const client = fakeClient();
    const session = await openPostgresSession(driverOf(client), connection({ mode: 'write' }));
    await session.query({ text: 'DELETE FROM t WHERE id = $1', params: [1], maxRows: 1 });
    await session.close();
    expect(client.queries.map((query) => query.text)).toStrictEqual([
      'BEGIN',
      'DELETE FROM t WHERE id = $1',
      'SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
      'COMMIT',
    ]);
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

  /**
   * `pg` does expose `Client` as a named export, and this proves it against
   * the namespace Node's loader really offers rather than vitest's interop
   * proxy, so a dependency bump that moved it would fail here.
   */
  it('ACT-84 the client is built from the export Node really offers, not the interop proxy', async () => {
    const namespace = { ...(await import('pg')) };
    const built = postgresDriverFrom(namespace)(configOf(connection()));
    expect(built.query).toBeTypeOf('function');
    expect(built.end).toBeTypeOf('function');
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
