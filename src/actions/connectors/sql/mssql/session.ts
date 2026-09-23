/**
 * The SQL Server session over `mssql` (ACT-84), the Tedious-based driver:
 * one connection per call (a pool of exactly one, created and closed with
 * the call, ACT-86), opened to the pinned address with the host name kept
 * for TLS through Tedious's `serverName` (ACT-55), bounded by the driver's
 * request timeout and the engine's abort signal, and cancelled on abort.
 * SQL Server has no read-only session, so the classification of ACT-37 and
 * the least-privilege login of ACT-85 are the controls, as the guide says.
 * The driver is loaded through a dynamic import (ACT-73).
 */
import { actionErrorOf, type FaultCodes } from '../failures.ts';
import { toSqlScalar, toSqlString, type SqlRow, type SqlScalar } from '../values.ts';

import type { SqlColumn, SqlConnection, SqlRows, SqlSession } from '../session.ts';

interface MssqlColumnMeta {
  readonly name: string;
  readonly type: { readonly declaration: string };
}

interface MssqlResult {
  readonly recordset?: readonly (readonly unknown[])[];
  readonly columns?: readonly (readonly MssqlColumnMeta[])[];
  readonly rowsAffected: readonly number[];
}

interface MssqlRequest {
  arrayRowMode: boolean;
  input(name: string, value: unknown): void;
  query(command: string): Promise<MssqlResult>;
  cancel(): void;
}

export interface MssqlPool {
  connect(): Promise<unknown>;
  request(): MssqlRequest;
  close(): Promise<void>;
}

export interface MssqlConfig {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly pool: { readonly max: number; readonly min: number };
  readonly options: {
    readonly serverName: string;
    readonly encrypt: boolean;
    readonly trustServerCertificate: boolean;
    readonly cryptoCredentialsDetails?: { readonly ca: string };
  };
}

export type MssqlDriver = (config: MssqlConfig) => MssqlPool;

/**
 * `ELOGIN` is the server refusing the login, `ETIMEOUT` and `ECANCEL` are the
 * request timing out or being cancelled, and the socket codes are the
 * connection. `EREQUEST`, which carries a SQL error raised after sign-in, has
 * no entry and is `upstream_error` with the server's message.
 */
const MSSQL_FAULTS: FaultCodes = {
  EAI_AGAIN: 'connection_failed',
  ECANCEL: 'timeout',
  ECONNREFUSED: 'connection_failed',
  ECONNRESET: 'connection_failed',
  EHOSTUNREACH: 'connection_failed',
  EINSTLOOKUP: 'connection_failed',
  ELOGIN: 'authentication_failed',
  ENETUNREACH: 'connection_failed',
  ENOCONN: 'connection_failed',
  ENOTFOUND: 'connection_failed',
  ESELFSIGNEDCERTIFICATE: 'tls_error',
  ESOCKET: 'connection_failed',
  ETIMEDOUT: 'connection_failed',
  ETIMEOUT: 'timeout',
};

/**
ACT-24: Tedious parses these as JavaScript numbers, which cannot hold them; they leave as strings.
*/
const EXACT_TYPES: ReadonlySet<string> = new Set(['decimal', 'money', 'numeric', 'smallmoney']);

export function configOf(connection: SqlConnection): MssqlConfig {
  const ca = connection.caPem;
  return {
    server: connection.address,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeout: connection.connectTimeoutMs,
    requestTimeout: connection.statementTimeoutMs,
    pool: { max: 1, min: 0 },
    options: {
      serverName: connection.host,
      encrypt: connection.tls !== 'disable',
      trustServerCertificate: false,
      ...(ca !== undefined && { cryptoCredentialsDetails: { ca } }),
    },
  };
}

function scalarOf(value: unknown, type: string | undefined): SqlScalar {
  return type !== undefined && EXACT_TYPES.has(type) ? toSqlString(value) : toSqlScalar(value);
}

function columnsOf(result: MssqlResult): readonly SqlColumn[] {
  const [first = []] = result.columns ?? [];
  return first.map((column) => ({ name: column.name, type: column.type.declaration }));
}

function rowsOf(
  result: MssqlResult,
  columns: readonly SqlColumn[],
  maxRows: number,
): readonly SqlRow[] {
  return (result.recordset ?? [])
    .slice(0, maxRows)
    .map((row) => row.map((value, index) => scalarOf(value, columns[index]?.type)));
}

async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // The call already has its outcome; a failed close never changes it.
  }
}

function createSession(pool: MssqlPool, connection: SqlConnection): SqlSession {
  let running: MssqlRequest | undefined;
  const cancel = (): void => {
    running?.cancel();
    void quietly(pool.close());
  };
  connection.signal.addEventListener('abort', cancel, { once: true });
  return {
    async query(request) {
      const command = pool.request();
      command.arrayRowMode = true;
      for (const [index, value] of request.params.entries()) {
        command.input(`p${index + 1}`, value);
      }
      running = command;
      try {
        const result = await command.query(request.text);
        const columns = columnsOf(result);
        const rows: SqlRows = {
          columns,
          rows: rowsOf(result, columns, request.maxRows),
          rowsAffected: result.rowsAffected.reduce((total, count) => total + count, 0),
        };
        return rows;
      } catch (error) {
        throw actionErrorOf(error, MSSQL_FAULTS);
      } finally {
        running = undefined;
      }
    },
    async close() {
      connection.signal.removeEventListener('abort', cancel);
      await pool.close();
    },
  };
}

export async function openMssqlSession(
  create: MssqlDriver,
  connection: SqlConnection,
): Promise<SqlSession> {
  const pool = create(configOf(connection));
  try {
    await pool.connect();
  } catch (error) {
    await quietly(pool.close());
    throw actionErrorOf(error, MSSQL_FAULTS);
  }
  return createSession(pool, connection);
}

/**
ACT-73: `mssql` is reached only from here, and only when a `sql` call actually runs.
*/
export async function loadMssqlDriver(): Promise<MssqlDriver> {
  const { ConnectionPool } = await import('mssql');
  return (config) => new ConnectionPool(config);
}

export async function mssqlSession(
  connection: SqlConnection,
  load: () => Promise<MssqlDriver> = loadMssqlDriver,
): Promise<SqlSession> {
  return openMssqlSession(await load(), connection);
}
