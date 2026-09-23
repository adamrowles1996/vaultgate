/**
 * One `sql_query` or `sql_execute` against a database (§14.4): the statement
 * classified and its placeholders checked before anything connects (ACT-26,
 * ACT-23), the credential placed in the login, one session opened to the
 * pinned address with the host name kept for TLS (ACT-55) and closed in
 * `finally` (ACT-86), and the rows fitted to the target's row and output
 * limits. The tool decides the session's mode and the shape of the result
 * (ACT-24, ACT-25). No pool, so an idle deployment holds no database sessions
 * and a rotated password takes effect on the next call.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { bindingProblem, classifyStatement } from './classify.ts';
import { faultOf } from './failures.ts';
import { SQL_QUERY_TOOL } from './operation.ts';
import { portOf, statementTimeoutOf } from './schemas.ts';
import { fitRows } from './values.ts';

import type { SqlOperation } from './operation.ts';
import type { SqlCredential, SqlDestination, SqlPolicy } from './schemas.ts';
import type { SqlConnection, SqlRows, SqlSession, SqlSessions } from './session.ts';
import type { Logger } from '../../../logger.ts';
import type { InjectedValues } from '../../scrub.ts';
import type { ConnectorOutput, RunContext } from '../connector.ts';

const MESSAGE_CAP = 1024;

export type SqlRunContext = RunContext<SqlDestination, SqlCredential, SqlPolicy>;

export type SqlRun = (
  context: SqlRunContext,
  operation: SqlOperation,
) => Promise<Result<ConnectorOutput, ActionError>>;

interface Login {
  readonly username: string;
  readonly password: string;
}

/**
ACT-50: the injected password and the mapping's username, held only for the length of this call.
*/
function loginOf(credential: SqlCredential, injected: InjectedValues): Result<Login, ActionError> {
  const password = injected.value(credential.password_field)?.toString('utf8');
  const username = injected.username;
  return password === undefined || username === undefined
    ? fail(new ActionError('credential_unavailable'))
    : ok({ username, password });
}

function connectionOf(context: SqlRunContext, address: string, login: Login): SqlConnection {
  const { destination, policy } = context;
  return {
    host: destination.host,
    address,
    port: portOf(destination),
    database: destination.database,
    username: login.username,
    password: login.password,
    tls: destination.tls,
    caPem: destination.ca_pem,
    mode: context.tool === SQL_QUERY_TOOL ? 'read' : 'write',
    connectTimeoutMs: policy.timeout_ms,
    statementTimeoutMs: statementTimeoutOf(policy),
    signal: context.signal,
  };
}

/**
Everything the call needs before it connects; every refusal here happens with no session open.
*/
function prepare(
  context: SqlRunContext,
  operation: SqlOperation,
): Result<SqlConnection, ActionError> {
  const [endpoint] = context.pinned;
  if (endpoint === undefined) {
    return fail(new ActionError('destination_refused', { reason: 'unpinned' }));
  }
  const reading = classifyStatement(operation.statement, context.destination.engine);
  if (!reading.ok) {
    return fail(new ActionError('policy_denied', { reason: reading.reason }));
  }
  const problem = bindingProblem(
    reading.facts.positions,
    operation.params.length,
    context.destination.engine,
  );
  if (problem !== undefined) {
    return fail(new ActionError('invalid_arguments', { problem }));
  }
  const login = loginOf(context.credential, context.injected);
  return login.ok ? ok(connectionOf(context, endpoint.address, login.value)) : login;
}

/**
ACT-24 for `sql_query`, ACT-25 for `sql_execute`; both cap the rows at the target's limits.
*/
function toOutput(context: SqlRunContext, rows: SqlRows): ConnectorOutput {
  const fitted = fitRows(rows.rows, context.policy.max_rows, context.outputLimit.maxBytes);
  const shared = { columns: rows.columns, rows: fitted.rows, truncated: fitted.truncated };
  return {
    result:
      context.tool === SQL_QUERY_TOOL
        ? { ...shared, row_count: fitted.rows.length }
        : { ...shared, rows_affected: rows.rowsAffected },
    captured: {},
    bytes: fitted.bytes,
  };
}

/**
A session that will not close is logged for the operator; it never changes the call's outcome.
*/
async function closeQuietly(session: SqlSession, logger: Logger): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    logger.warn({ reason: faultOf(error).message }, 'the sql session did not close cleanly');
  }
}

function failureOf(error: unknown): ActionError {
  return error instanceof ActionError
    ? error
    : new ActionError('upstream_error', {
        message: faultOf(error).message.slice(0, MESSAGE_CAP),
      });
}

/**
`run` of the `sql` connector over injected session factories, one per engine (ACT-78).
*/
export function createRun(sessions: SqlSessions): SqlRun {
  return async (context, operation) => {
    const prepared = prepare(context, operation);
    if (!prepared.ok) {
      return prepared;
    }
    let session: SqlSession | undefined;
    try {
      session = await sessions[context.destination.engine](prepared.value);
      const rows = await session.query({
        text: operation.statement,
        params: operation.params,
        maxRows: context.policy.max_rows + 1,
      });
      return ok(toOutput(context, rows));
    } catch (error) {
      return fail(failureOf(error));
    } finally {
      if (session !== undefined) {
        await closeQuietly(session, context.logger);
      }
    }
  };
}
