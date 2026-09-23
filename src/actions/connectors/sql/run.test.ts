import { describe, expect, it } from 'vitest';

import { PUBLIC_ADDRESS } from '../../../test-support/actions-fixtures.ts';
import { fakeSqlSessions, rowsOf } from '../../../test-support/fake-sql-session.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import {
  SQL_HOST,
  sqlRunContext,
  type SqlContextOptions,
} from '../../../test-support/sql-connector.ts';
import { ActionError } from '../../errors.ts';

import { sqlQuerySchema } from './operation.ts';
import { createRun } from './run.ts';

import type { Result } from '../../../result.ts';
import type { FakeOptions, FakeSessions } from '../../../test-support/fake-sql-session.ts';
import type { ConnectorOutput } from '../connector.ts';

interface Ran {
  readonly fake: FakeSessions;
  readonly built: ReturnType<typeof sqlRunContext>;
  readonly outcome: Result<ConnectorOutput, ActionError>;
}

async function run(
  toolArguments: Readonly<Record<string, unknown>> = {},
  options: SqlContextOptions = {},
  fakeOptions: FakeOptions = {},
): Promise<Ran> {
  const fake = fakeSqlSessions(fakeOptions);
  const built = sqlRunContext(options);
  const operation = sqlQuerySchema.parse({ statement: 'SELECT 1', ...toolArguments });
  const outcome = await createRun(fake.sessions)(built.context, operation);
  return { fake, built, outcome };
}

describe('running a sql_query', () => {
  it('ACT-55 ACT-86 opens one session to the pinned address with the host name kept for TLS, and closes it', async () => {
    const ran = await run();
    expect(ran.fake.opened).toHaveLength(1);
    expect(ran.fake.opened[0]).toMatchObject({
      address: PUBLIC_ADDRESS,
      host: SQL_HOST,
      port: 5432,
      database: 'reporting',
      username: 'alice@example.com',
      readOnly: true,
      tls: 'require',
    });
    expect(ran.fake.closed).toStrictEqual([1]);
  });

  it('ACT-24 returns the columns, the rows and the row count', async () => {
    const ran = await run(
      {},
      {},
      {
        answers: [
          rowsOf(
            ['id', 'name'],
            [
              [1, 'a'],
              [2, 'b'],
            ],
          ),
        ],
      },
    );
    expect(unwrapOk(ran.outcome)).toStrictEqual({
      result: {
        columns: [
          { name: 'id', type: 'text' },
          { name: 'name', type: 'text' },
        ],
        rows: [
          [1, 'a'],
          [2, 'b'],
        ],
        row_count: 2,
        truncated: false,
      },
      captured: {},
      bytes: 16,
    });
  });

  it('ACT-24 asks the session for one row more than the policy allows, so truncation is visible', async () => {
    const answers = [rowsOf(['n'], [[1], [2], [3]])];
    const ran = await run({}, { policy: { max_rows: 2 } }, { answers });
    expect(ran.fake.requests[0]).toStrictEqual({
      text: 'SELECT 1',
      params: [],
      maxRows: 3,
    });
    expect(unwrapOk(ran.outcome).result).toMatchObject({ row_count: 2, truncated: true });
  });

  it('ACT-23 binds the parameters positionally', async () => {
    const ran = await run({ statement: 'SELECT $1, $2', params: ['a', 2] });
    expect(ran.fake.requests[0]?.params).toStrictEqual(['a', 2]);
    expect(ran.outcome.ok).toBe(true);
  });

  it('ACT-23 refuses a placeholder without a parameter before anything connects', async () => {
    const ran = await run({ statement: 'SELECT $1' });
    expect(unwrapFail(ran.outcome).code).toBe('invalid_arguments');
    expect(ran.fake.opened).toStrictEqual([]);
  });

  it('ACT-23 refuses a parameter without a placeholder before anything connects', async () => {
    const ran = await run({ statement: 'SELECT 1', params: ['a'] });
    expect(unwrapFail(ran.outcome).code).toBe('invalid_arguments');
    expect(ran.fake.opened).toStrictEqual([]);
  });

  it('ACT-26 ACT-36 refuses a second statement before anything connects', async () => {
    const ran = await run({ statement: 'SELECT 1; DROP TABLE x' });
    const error = unwrapFail(ran.outcome);
    expect(error.code).toBe('policy_denied');
    expect(error.detail).toStrictEqual({ reason: 'statement_count' });
    expect(ran.fake.opened).toStrictEqual([]);
  });

  it('ACT-55 refuses to run when the engine pinned no address', async () => {
    const ran = await run({}, { pinned: [] });
    expect(unwrapFail(ran.outcome).detail).toStrictEqual({ reason: 'unpinned' });
    expect(ran.fake.opened).toStrictEqual([]);
  });

  it('ACT-54 a missing password or login name is credential_unavailable and nothing connects', async () => {
    const withoutName = await run({}, { username: undefined });
    expect(unwrapFail(withoutName.outcome).code).toBe('credential_unavailable');
    const fake = fakeSqlSessions();
    const built = sqlRunContext();
    built.context.injected.dispose();
    const emptied = await createRun(fake.sessions)(
      {
        ...built.context,
        credential: { username_from: 'login.username', password_field: 'other' },
      },
      sqlQuerySchema.parse({ statement: 'SELECT 1' }),
    );
    expect(unwrapFail(emptied).code).toBe('credential_unavailable');
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-74 a session that fails with an action error keeps that code', async () => {
    const ran = await run({}, {}, { answers: [new ActionError('authentication_failed')] });
    expect(unwrapFail(ran.outcome).code).toBe('authentication_failed');
    expect(ran.fake.closed).toStrictEqual([1]);
  });

  it('ACT-74 a session that throws anything else is upstream_error with a capped message', async () => {
    const ran = await run({}, {}, { answers: [new Error('x'.repeat(2000))] });
    const error = unwrapFail(ran.outcome);
    expect(error.code).toBe('upstream_error');
    expect(error.detail).toStrictEqual({ message: 'x'.repeat(1024) });
  });

  it('ACT-86 a session that fails to open is the error, and nothing is left to close', async () => {
    const ran = await run({}, {}, { openError: new ActionError('connection_failed') });
    expect(unwrapFail(ran.outcome).code).toBe('connection_failed');
    expect(ran.fake.closed).toStrictEqual([]);
  });

  it('ACT-86 a session that will not close is logged and never changes the outcome', async () => {
    const ran = await run({}, {}, { closeError: new Error('socket already gone') });
    expect(unwrapOk(ran.outcome).result).toMatchObject({ row_count: 1 });
    expect(ran.built.logged()).toMatchObject([
      { reason: 'socket already gone', msg: 'the sql session did not close cleanly' },
    ]);
  });

  it('ACT-59 an aborted call ends as timeout and the session is still closed', async () => {
    const fake = fakeSqlSessions({ answers: ['hang'] });
    const built = sqlRunContext();
    const pending = createRun(fake.sessions)(
      built.context,
      sqlQuerySchema.parse({ statement: 'SELECT 1' }),
    );
    built.controller.abort();
    expect(unwrapFail(await pending).code).toBe('timeout');
    expect(fake.closed).toStrictEqual([1]);
  });

  it('ACT-84 a SQL Server target is run through the SQL Server session factory', async () => {
    const postgres = fakeSqlSessions();
    const mssql = fakeSqlSessions();
    const built = sqlRunContext({ engine: 'mssql' });
    await createRun({ postgres: postgres.sessions.postgres, mssql: mssql.sessions.mssql })(
      built.context,
      sqlQuerySchema.parse({ statement: 'SELECT 1' }),
    );
    expect(mssql.opened).toHaveLength(1);
    expect(postgres.opened).toStrictEqual([]);
  });
});
