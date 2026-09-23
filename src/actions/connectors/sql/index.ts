/**
 * The `sql` connector runtime (spec §14.4, M11): the document schemas, the
 * `sql_query` and `sql_execute` tools, the pure policy half (classification,
 * ACT-36…38) and `run` over injected session factories, one per engine
 * (ACT-78).
 * `sqlConnector` is what the registry loads on a deployment with
 * `VAULTGATE_ACTIONS_ENABLE_SQL=true`; contract tests build one with
 * `createSqlConnector` over fake sessions.
 */
import { authorize, capabilities, describeOperation } from './authorize.ts';
import { mssqlSession } from './mssql/session.ts';
import { sqlExecuteTool, sqlQueryTool, type SqlOperation } from './operation.ts';
import { postgresSession } from './postgres/session.ts';
import { createRun } from './run.ts';
import { sqlSchemas, type SqlCredential, type SqlDestination, type SqlPolicy } from './schemas.ts';

import type { SqlSessions } from './session.ts';
import type { Connector } from '../connector.ts';

export type SqlConnector = Connector<SqlDestination, SqlCredential, SqlPolicy, SqlOperation>;

export function createSqlConnector(sessions: SqlSessions): SqlConnector {
  return {
    ...sqlSchemas,
    tools: [sqlQueryTool, sqlExecuteTool],
    capabilities,
    authorize,
    describe: describeOperation,
    run: createRun(sessions),
  };
}

export const sqlConnector: SqlConnector = createSqlConnector({
  mssql: mssqlSession,
  postgres: postgresSession,
});
