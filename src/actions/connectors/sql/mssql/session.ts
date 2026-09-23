/**
 * The SQL Server session over `mssql` (ACT-84), the Tedious-based driver:
 * one connection per call (a pool of exactly one, created and closed with
 * the call, ACT-86), opened to the pinned address with the host name kept
 * for TLS through Tedious's `serverName` (ACT-55, and only a name: this
 * engine cannot verify a certificate against an address, so `saveProblems`
 * refuses such a destination), bounded by the driver's
 * request timeout and the engine's abort signal, and cancelled on abort.
 * SQL Server has no read-only session, so for a read the classification of
 * ACT-37 and the least-privilege login of ACT-85 are the controls, as the
 * guide says; a write runs inside a transaction of its own, committed when it
 * succeeds and rolled back on any error (ACT-25). The driver is loaded
 * through a dynamic import (ACT-73).
 */
import { isIP } from 'node:net';

import { driverModule } from '../drivers.ts';
import { actionErrorOf, type FaultCodes } from '../failures.ts';
import { toSqlScalar, type SqlRow, type SqlScalar } from '../values.ts';

import { EXACT_TYPES, exactScalar } from './exact.ts';

import type { SqlConnection, SqlRequest, SqlRows, SqlSession } from '../session.ts';
import type * as Mssql from 'mssql';

interface MssqlColumnMeta {
  readonly name: string;
  readonly type: { readonly declaration: string };
  /**
  ACT-24: the declared number of decimal places, present on the exact numerics.
  */
  readonly scale?: number;
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

/**
ACT-25: the driver's own transaction, whose `request` runs on the transaction's connection.
*/
interface MssqlTransaction {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  request(): MssqlRequest;
}

export interface MssqlPool {
  connect(): Promise<unknown>;
  request(): MssqlRequest;
  transaction(): MssqlTransaction;
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
    readonly serverName?: string;
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

export function configOf(connection: SqlConnection): MssqlConfig {
  const ca = connection.caPem;
  /**
   * ACT-55, ACT-57: the host name is the TLS server name, but Tedious puts it
   * straight into `tls.connect`, which refuses an IP literal as SNI, and its
   * in-band TLS path gives the socket no host to verify an address against
   * instead. A destination named by address therefore cannot be verified on
   * this engine at all, which is why `saveProblems` refuses one before an
   * operator can save it; nothing is sent here, so an SNI extension never
   * carries an address.
   */
  const isNamedHost = isIP(connection.host) === 0;
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
      ...(isNamedHost && { serverName: connection.host }),
      encrypt: connection.tls !== 'disable',
      trustServerCertificate: false,
      ...(ca !== undefined && { cryptoCredentialsDetails: { ca } }),
    },
  };
}

function scalarOf(value: unknown, column: MssqlColumnMeta | undefined): SqlScalar {
  if (column === undefined || !EXACT_TYPES.has(column.type.declaration)) {
    return toSqlScalar(value);
  }
  const { name, scale } = column;
  return exactScalar(value, { name, type: column.type.declaration, scale });
}

function declaredColumns(result: MssqlResult): readonly MssqlColumnMeta[] {
  const [first = []] = result.columns ?? [];
  return first;
}

function rowsOf(
  result: MssqlResult,
  columns: readonly MssqlColumnMeta[],
  maxRows: number,
): readonly SqlRow[] {
  return (result.recordset ?? [])
    .slice(0, maxRows)
    .map((row) => row.map((value, index) => scalarOf(value, columns[index])));
}

async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // The call already has its outcome; a failed close never changes it.
  }
}

/**
The driver's own request, told to hand rows back as arrays and given the parameters positionally.
*/
function prepared(open: () => MssqlRequest, request: SqlRequest): MssqlRequest {
  const command = open();
  command.arrayRowMode = true;
  for (const [index, value] of request.params.entries()) {
    command.input(`p${index + 1}`, value);
  }
  return command;
}

function toRows(result: MssqlResult, maxRows: number): SqlRows {
  const declared = declaredColumns(result);
  return {
    columns: declared.map((column) => ({ name: column.name, type: column.type.declaration })),
    rows: rowsOf(result, declared, maxRows),
    rowsAffected: result.rowsAffected.reduce((total, count) => total + count, 0),
  };
}

/**
 * ACT-25: a write runs inside the driver's transaction, committed when the
 * statement succeeds and rolled back on any error, so a statement that fails
 * half way leaves nothing behind.
 */
async function inTransaction(
  pool: MssqlPool,
  request: SqlRequest,
  running: (command: MssqlRequest | undefined) => void,
): Promise<MssqlResult> {
  const transaction = pool.transaction();
  await transaction.begin();
  const command = prepared(() => transaction.request(), request);
  running(command);
  try {
    const result = await command.query(request.text);
    await transaction.commit();
    return result;
  } catch (error) {
    await quietly(transaction.rollback());
    throw error;
  }
}

function createSession(pool: MssqlPool, connection: SqlConnection): SqlSession {
  let running: MssqlRequest | undefined;
  const cancel = (): void => {
    running?.cancel();
    void quietly(pool.close());
  };
  /**
  ACT-59: a statement that only starts after the abort — the `BEGIN` of a write was still in
  flight — is cancelled the moment it exists, not left to run on a closing connection.
  */
  const remember = (command: MssqlRequest | undefined): void => {
    running = command;
    if (connection.signal.aborted) {
      command?.cancel();
    }
  };
  connection.signal.addEventListener('abort', cancel, { once: true });
  const execute = async (request: SqlRequest): Promise<MssqlResult> => {
    if (connection.mode === 'write') {
      return inTransaction(pool, request, remember);
    }
    const command = prepared(() => pool.request(), request);
    remember(command);
    return command.query(request.text);
  };
  return {
    async query(request) {
      try {
        return toRows(await execute(request), request.maxRows);
      } catch (error) {
        throw actionErrorOf(error, MSSQL_FAULTS);
      } finally {
        remember(undefined);
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
 * ACT-84: `mssql` is CommonJS and `ConnectionPool` is not a named export Node
 * can see, so the class comes off the module's `default` (`drivers.ts`).
 */
export function mssqlDriverFrom(module: typeof Mssql): MssqlDriver {
  const { ConnectionPool } = driverModule(module, 'ConnectionPool');
  return (config) => new ConnectionPool(config);
}

/**
ACT-73: `mssql` is reached only from here, and only when a `sql` call actually runs.
*/
export async function loadMssqlDriver(): Promise<MssqlDriver> {
  return mssqlDriverFrom(await import('mssql'));
}

export async function mssqlSession(
  connection: SqlConnection,
  load: () => Promise<MssqlDriver> = loadMssqlDriver,
): Promise<SqlSession> {
  return openMssqlSession(await load(), connection);
}
