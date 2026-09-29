import { describe, expect, it } from 'vitest';

import {
  connectSdkClient,
  createActionsApp,
  type ActionsApp,
} from '../../../test-support/actions-app.ts';
import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import {
  fakeSqlSessions,
  rowsOf,
  type FakeSessions,
} from '../../../test-support/fake-sql-session.ts';
import {
  createSqlTarget,
  sqlConnectorOver,
  WRITE_POLICY,
} from '../../../test-support/sql-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

const SQL_ON = { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } as const;
const WRITE = ['actions:sql.read', 'actions:sql.write'];
const DELETE = {
  target: 'warehouse',
  statement: 'DELETE FROM sessions WHERE id = $1',
  params: ['s-1'],
};

interface Writer extends ActionsApp {
  readonly fake: FakeSessions;
  readonly token: string;
}

async function writerApp(): Promise<Writer> {
  const fake = fakeSqlSessions({ answers: [{ columns: [], rows: [], rowsAffected: 3 }] });
  const fixture = createActionsApp({ config: SQL_ON, runtime: sqlConnectorOver(fake) });
  await createSqlTarget(fixture.harness, { policy: WRITE_POLICY });
  return { ...fixture, fake, token: fixture.issue(WRITE) };
}

describe('sql_execute through the MCP client SDK', () => {
  it('ACT-25 ACT-40 runs the write at once, asking no one, in its own transaction, and records it', async () => {
    const { app, token, fake, harness } = await writerApp();
    const client = await connectSdkClient(app, { token });
    const result = await client.callTool({ name: 'sql_execute', arguments: DELETE });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows_affected: 3,
      columns: [],
      rows: [],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(CANARY.password);
    expect(fake.opened[0]).toMatchObject({ mode: 'write' });
    expect(fake.requests[0]).toMatchObject({ params: ['s-1'] });
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        tool: 'sql_execute',
        operation: 'write',
        classification: 'dml',
        elicitation: 'not_required',
      },
    ]);
  });
});

describe('the sql tools through the MCP client SDK', () => {
  it('ACT-14 ACT-18 tools/list advertises both sql tools to a token holding both scopes', async () => {
    const { app, issue } = createActionsApp({
      config: SQL_ON,
      runtime: sqlConnectorOver(fakeSqlSessions()),
    });
    const client = await connectSdkClient(app, { token: issue(WRITE) });
    const listed = await client.listTools();
    await client.close();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain('sql_query');
    expect(names).toContain('sql_execute');
    const execute = listed.tools.find((tool) => tool.name === 'sql_execute');
    expect(execute?.annotations).toStrictEqual({
      title: 'SQL execute',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    const properties = execute?.outputSchema?.['properties'] ?? {};
    expect(Object.keys(properties)).toStrictEqual([
      'rows_affected',
      'columns',
      'rows',
      'truncated',
      'duration_ms',
    ]);
  });

  it('ACT-12 ACT-14 a token with only actions:sql.read can neither see nor call sql_execute', async () => {
    const fake = fakeSqlSessions();
    const { app, harness, issue } = createActionsApp({
      config: SQL_ON,
      runtime: sqlConnectorOver(fake),
    });
    await createSqlTarget(harness, { policy: WRITE_POLICY });
    const client = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('sql_execute');
    // The scope gate answers the OAUTH-33 challenge before the engine is reached, which the
    // SDK raises rather than returning as a tool result.
    await expect(client.callTool({ name: 'sql_execute', arguments: DELETE })).rejects.toThrow(
      /actions:sql\.write/u,
    );
    await client.close();
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-19 lists the operations the policy allows and the token can reach', async () => {
    const sessions = fakeSqlSessions({ answers: [rowsOf(['n'], [[1]])] });
    const { app, harness, issue } = createActionsApp({
      config: SQL_ON,
      runtime: sqlConnectorOver(sessions),
    });
    await createSqlTarget(harness, { policy: WRITE_POLICY });
    const writer = await connectSdkClient(app, { token: issue(WRITE) });
    const both = await writer.callTool({ name: 'actions_list_targets', arguments: {} });
    await writer.close();
    expect(both.structuredContent).toStrictEqual({
      targets: [
        {
          name: 'warehouse',
          description: 'The reporting replica',
          connector: 'sql',
          operations: ['read', 'write'],
          engine: 'postgres',
        },
      ],
    });
    const reader = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
    });
    const readOnly = await reader.callTool({ name: 'actions_list_targets', arguments: {} });
    await reader.close();
    expect(readOnly.structuredContent).toMatchObject({ targets: [{ operations: ['read'] }] });
  });
});
