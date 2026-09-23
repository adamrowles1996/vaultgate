/**
 * The transport a `sql` call runs over (ACT-78): one session, opened after
 * the policy decision, used for one statement and closed when the call ends
 * (ACT-86). `postgres/session.ts` and `mssql/session.ts` implement it over
 * their drivers; `src/test-support/fake-sql-session.ts` implements it for
 * the contract tests, so no test needs a database.
 */
import type { SqlDestination } from './schemas.ts';
import type { SqlRow, SqlScalar } from './values.ts';

export type SqlParameter = SqlScalar;

export interface SqlColumn {
  readonly name: string;
  /**
  The engine's own type name (ACT-24), lower-cased as the driver reports it.
  */
  readonly type: string;
}

export interface SqlRows {
  readonly columns: readonly SqlColumn[];
  readonly rows: readonly SqlRow[];
  readonly rowsAffected: number;
}

export interface SqlRequest {
  readonly text: string;
  readonly params: readonly SqlParameter[];
  /**
  At most this many rows are collected; `run` asks for one more than the policy allows.
  */
  readonly maxRows: number;
}

export interface SqlSession {
  query(request: SqlRequest): Promise<SqlRows>;
  close(): Promise<void>;
}

export interface SqlConnection {
  /**
  ACT-55: the host name, kept for TLS (SNI and certificate verification) and for nothing else.
  */
  readonly host: string;
  /**
  ACT-55: the address the engine resolved and validated once for this call; the socket goes here.
  */
  readonly address: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly tls: SqlDestination['tls'];
  readonly caPem: string | undefined;
  /**
   * ACT-85: a `read` session is opened read-only on the engines that can
   * enforce it; ACT-25: a `write` session runs its statement in its own
   * transaction, committed on success and rolled back on any error.
   */
  readonly mode: 'read' | 'write';
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /**
  ACT-59: aborted when the policy timeout elapses; the session cancels the statement and closes.
  */
  readonly signal: AbortSignal;
}

export type SqlSessionFactory = (connection: SqlConnection) => Promise<SqlSession>;

export type SqlSessions = Readonly<Record<SqlDestination['engine'], SqlSessionFactory>>;
