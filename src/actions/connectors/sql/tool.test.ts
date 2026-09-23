import { describe, expect, it } from 'vitest';

import { connectSdkClient, createActionsApp } from '../../../test-support/actions-app.ts';
import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import { fakeSqlSessions, rowsOf } from '../../../test-support/fake-sql-session.ts';
import { createSqlTarget, sqlConnectorOver } from '../../../test-support/sql-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import type { ActionsApp } from '../../../test-support/actions-app.ts';
import type { FakeSessions } from '../../../test-support/fake-sql-session.ts';

const SQL_ON = { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } as const;

function appOver(fake: FakeSessions): ActionsApp {
  return createActionsApp({ config: SQL_ON, runtime: sqlConnectorOver(fake) });
}

describe('sql_query through the MCP client SDK', () => {
  it('ACT-23 ACT-24 ACT-51 runs one parameterised read and returns the rows with the credential scrubbed', async () => {
    const fake = fakeSqlSessions({
      answers: [rowsOf(['id', 'secret'], [[7, CANARY.password]])],
    });
    const { app, harness, issue } = appOver(fake);
    await createSqlTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'sql_query',
      arguments: {
        target: 'warehouse',
        statement: 'SELECT id, secret FROM t WHERE id = $1',
        params: [7],
      },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      columns: [
        { name: 'id', type: 'text' },
        { name: 'secret', type: 'text' },
      ],
      rows: [[7, '[redacted:password]']],
      row_count: 1,
      truncated: false,
    });
    expect(fake.requests[0]).toMatchObject({
      text: 'SELECT id, secret FROM t WHERE id = $1',
      params: [7],
    });
    expect(JSON.stringify(result)).not.toContain(CANARY.password);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', tool: 'sql_query', operation: 'read', classification: 'read' },
    ]);
  });

  it('ACT-26 ACT-39 refuses a statement that is not a read, with the reason and nothing connected', async () => {
    const fake = fakeSqlSessions();
    const { app, harness, issue } = appOver(fake);
    await createSqlTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'sql_query',
      arguments: { target: 'warehouse', statement: 'DROP TABLE orders' },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: 'policy_denied',
      detail: { reason: 'statement_class' },
    });
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-17 ACT-18 ACT-15 tools/list advertises sql_query with target first, the 13.6.1 annotations and strict schemas', async () => {
    const { app, issue } = appOver(fakeSqlSessions());
    const client = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    const tool = listed.tools.find((candidate) => candidate.name === 'sql_query');
    expect(tool?.annotations).toStrictEqual({
      title: 'SQL query',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tool?.description).toContain('$1…$n');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['target', 'statement'],
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toStrictEqual([
      'target',
      'statement',
      'params',
    ]);
    expect(tool?.outputSchema).toMatchObject({ additionalProperties: false });
    expect(Object.keys(tool?.outputSchema?.['properties'] ?? {})).toStrictEqual([
      'columns',
      'rows',
      'row_count',
      'truncated',
      'duration_ms',
    ]);
  });

  it('ACT-14 a token without actions:sql.read cannot see or call the tool', async () => {
    const { app, harness, issue } = appOver(fakeSqlSessions());
    await createSqlTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:http']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('sql_query');
  });
});
