/**
 * The PostgreSQL session over `pg` (ACT-84): one `Client` per call, opened
 * to the pinned address with the host name kept for TLS (ACT-55), bounded by
 * the server's own `statement_timeout` as well as the engine's abort signal,
 * and closed when the call ends (ACT-86). The statement always runs inside a
 * transaction of its own, committed when it succeeds and rolled back on any
 * error (ACT-25); a read session opens it `READ ONLY` and sets
 * `default_transaction_read_only` besides (ACT-85). The driver is loaded
 * through a dynamic import, so a deployment that never enables `sql` never
 * loads it (ACT-73).
 */
import { actionErrorOf, type FaultCodes } from '../failures.ts';
import { toSqlScalar, type SqlRow } from '../values.ts';

import type { SqlColumn, SqlConnection, SqlRows, SqlSession } from '../session.ts';
import type { ClientConfig } from 'pg';

interface PostgresField {
  readonly name: string;
  readonly dataTypeID: number;
}

interface PostgresResult {
  readonly fields: readonly PostgresField[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number | null;
}

interface PostgresQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly rowMode?: 'array';
}

export interface PostgresClient {
  connect(): Promise<unknown>;
  query(query: PostgresQuery): Promise<PostgresResult>;
  end(): Promise<void>;
}

export type PostgresDriver = (config: ClientConfig) => PostgresClient;

/**
 * SQLSTATE `28xxx` is the server refusing the login and `57014` is a
 * statement the server cancelled, which is what `statement_timeout` does;
 * everything else at this layer is the socket. A SQL error after sign-in has
 * no entry and is `upstream_error` with the server's message.
 */
const POSTGRES_FAULTS: FaultCodes = {
  '28000': 'authentication_failed',
  '28P01': 'authentication_failed',
  '57014': 'timeout',
  EAI_AGAIN: 'connection_failed',
  ECONNREFUSED: 'connection_failed',
  ECONNRESET: 'connection_failed',
  EHOSTUNREACH: 'connection_failed',
  ENETUNREACH: 'connection_failed',
  ENOTFOUND: 'connection_failed',
  EPIPE: 'connection_failed',
  ETIMEDOUT: 'connection_failed',
};

const TYPE_NAMES = 'SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])';

/**
ACT-25, ACT-85: a read statement runs in a read-only transaction, a write in an ordinary one.
*/
const BEGIN: Readonly<Record<SqlConnection['mode'], string>> = {
  read: 'BEGIN READ ONLY',
  write: 'BEGIN',
};

function sslOf(connection: SqlConnection): ClientConfig['ssl'] {
  if (connection.tls === 'disable') {
    return false;
  }
  return {
    servername: connection.host,
    rejectUnauthorized: true,
    ...(connection.caPem !== undefined && { ca: connection.caPem }),
  };
}

export function configOf(connection: SqlConnection): ClientConfig {
  return {
    host: connection.address,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl: sslOf(connection),
    statement_timeout: connection.statementTimeoutMs,
    connectionTimeoutMillis: connection.connectTimeoutMs,
    application_name: 'vaultgate',
  };
}

/**
 * ACT-24: the engine's own type name per column, read from `pg_type` for the
 * oids this result uses, so an enum or a domain is named as the database
 * names it rather than as a number.
 */
async function columnsOf(
  client: PostgresClient,
  fields: readonly PostgresField[],
): Promise<readonly SqlColumn[]> {
  if (fields.length === 0) {
    return [];
  }
  const oids = [...new Set(fields.map((field) => field.dataTypeID))];
  const named = await client.query({ text: TYPE_NAMES, values: [oids], rowMode: 'array' });
  const names = new Map(
    named.rows.map((row) => [Number(toSqlScalar(row[0])), String(toSqlScalar(row[1]))]),
  );
  return fields.map((field) => ({
    name: field.name,
    type: names.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`,
  }));
}

function rowsOf(result: PostgresResult, maxRows: number): readonly SqlRow[] {
  return result.rows.slice(0, maxRows).map((row) => row.map((value) => toSqlScalar(value)));
}

async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // The call already has its outcome; a failed rollback or close never changes it.
  }
}

function createSession(client: PostgresClient, connection: SqlConnection): SqlSession {
  const cancel = (): void => {
    void quietly(client.end());
  };
  connection.signal.addEventListener('abort', cancel, { once: true });
  return {
    async query(request) {
      try {
        await client.query({ text: BEGIN[connection.mode] });
        const result = await client.query({
          text: request.text,
          values: [...request.params],
          rowMode: 'array',
        });
        const rows: SqlRows = {
          columns: await columnsOf(client, result.fields),
          rows: rowsOf(result, request.maxRows),
          rowsAffected: result.rowCount ?? 0,
        };
        await client.query({ text: 'COMMIT' });
        return rows;
      } catch (error) {
        await quietly(client.query({ text: 'ROLLBACK' }));
        throw actionErrorOf(error, POSTGRES_FAULTS);
      }
    },
    async close() {
      connection.signal.removeEventListener('abort', cancel);
      await client.end();
    },
  };
}

/**
ACT-85, ACT-86: one connection, read-only for a read session, refused as one error code if it fails.
*/
export async function openPostgresSession(
  create: PostgresDriver,
  connection: SqlConnection,
): Promise<SqlSession> {
  const client = create(configOf(connection));
  try {
    await client.connect();
    if (connection.mode === 'read') {
      await client.query({ text: 'SET default_transaction_read_only = on' });
    }
  } catch (error) {
    await quietly(client.end());
    throw actionErrorOf(error, POSTGRES_FAULTS);
  }
  return createSession(client, connection);
}

/**
ACT-73: `pg` is reached only from here, and only when a `sql` call actually runs.
*/
export async function loadPostgresDriver(): Promise<PostgresDriver> {
  const { Client } = await import('pg');
  return (config) => new Client(config);
}

export async function postgresSession(
  connection: SqlConnection,
  load: () => Promise<PostgresDriver> = loadPostgresDriver,
): Promise<SqlSession> {
  return openPostgresSession(await load(), connection);
}
