import { describe, expect, it } from 'vitest';

import {
  connectSdkClient,
  createActionsApp,
  rawCall,
  requestStateOf,
  retryParameters,
  scriptedElicitation,
  type ActionsApp,
} from '../../../test-support/actions-app.ts';
import { OPERATOR_ID, storedCalls } from '../../../test-support/actions-fixtures.ts';
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
import { ACTION_ERROR_MESSAGES } from '../../errors.ts';

import type { ElicitResult } from '@modelcontextprotocol/client';

const SQL_ON = { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } as const;
const WRITE = ['actions:sql.read', 'actions:sql.write'];
const ACCEPT: ElicitResult = { action: 'accept', content: { confirm: true } };
const DELETE = {
  target: 'warehouse',
  statement: 'DELETE FROM sessions WHERE id = $1',
  params: ['s-1'],
};

interface Confirmed extends ActionsApp {
  readonly fake: FakeSessions;
  readonly token: string;
}

async function confirmedApp(policy: Readonly<Record<string, unknown>> = {}): Promise<Confirmed> {
  const fake = fakeSqlSessions({ answers: [{ columns: [], rows: [], rowsAffected: 3 }] });
  const fixture = createActionsApp({ config: SQL_ON, runtime: sqlConnectorOver(fake) });
  await createSqlTarget(fixture.harness, { policy: { ...WRITE_POLICY, ...policy } });
  return { ...fixture, fake, token: fixture.issue(WRITE) };
}

describe('sql_execute through the MCP client SDK', () => {
  it('ACT-25 ACT-40 ACT-41 ACT-47 ACT-76 runs the write once the human accepts, in its own transaction, and records it', async () => {
    const { app, token, fake, harness } = await confirmedApp();
    const script = scriptedElicitation([ACCEPT]);
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    const result = await client.callTool({ name: 'sql_execute', arguments: DELETE });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows_affected: 3,
      columns: [],
      rows: [],
      truncated: false,
    });
    expect(script.shown[0]?.params).toMatchObject({
      mode: 'form',
      message: expect.stringContaining('DELETE FROM sessions WHERE id = $1') as string,
      requestedSchema: { required: ['confirm'] },
    });
    expect(String(script.shown[0]?.params.message)).toContain('db.example.com:5432/reporting');
    expect(JSON.stringify(script.shown)).not.toContain(CANARY.password);
    expect(fake.opened[0]).toMatchObject({ mode: 'write' });
    expect(fake.requests[0]).toMatchObject({ params: ['s-1'] });
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        tool: 'sql_execute',
        operation: 'write',
        classification: 'dml',
        elicitation: 'accepted',
      },
    ]);
  });

  it('ACT-47 ACT-76 declines on accept without confirm, on decline, and cancels on cancel, none of them connecting', async () => {
    const { app, token, fake, harness } = await confirmedApp();
    const answers: readonly [ElicitResult, 'confirmation_cancelled' | 'confirmation_declined'][] = [
      [{ action: 'accept', content: { confirm: false } }, 'confirmation_declined'],
      [{ action: 'accept' }, 'confirmation_declined'],
      [{ action: 'decline' }, 'confirmation_declined'],
      [{ action: 'cancel' }, 'confirmation_cancelled'],
    ];
    const script = scriptedElicitation(answers.map(([answer]) => answer));
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    for (const [, code] of answers) {
      const result = await client.callTool({ name: 'sql_execute', arguments: DELETE });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toStrictEqual({
        error: code,
        message: ACTION_ERROR_MESSAGES[code],
      });
    }
    await client.close();
    expect(fake.opened).toStrictEqual([]);
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'declined',
      'declined',
      'declined',
      'cancelled',
    ]);
  });

  it('ACT-48 ACT-76 refuses a client that declares no elicitation before touching the vault or the database', async () => {
    const { app, token, fake, harness } = await confirmedApp();
    harness.lookups.length = 0;
    const client = await connectSdkClient(app, { token, elicitation: 'none' });
    const result = await client.callTool({ name: 'sql_execute', arguments: DELETE });
    await client.close();
    expect(result.structuredContent).toStrictEqual({
      error: 'confirmation_unavailable',
      message: ACTION_ERROR_MESSAGES.confirmation_unavailable,
    });
    expect(harness.lookups).toStrictEqual([]);
    expect(fake.opened).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:confirmation_unavailable', elicitation: 'unavailable' },
    ]);
  });

  it('ACT-49 a target that does not ask for confirmation runs the write without one', async () => {
    const { app, token, fake } = await confirmedApp({ confirm_writes: false });
    const script = scriptedElicitation([]);
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    const result = await client.callTool({ name: 'sql_execute', arguments: DELETE });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(script.shown).toStrictEqual([]);
    expect(fake.opened).toHaveLength(1);
  });
});

describe('retried sql_execute confirmations on the wire', () => {
  it('ACT-46 ACT-76 runs an accepted retry once and refuses its replay as confirmation_reused', async () => {
    const { app, token, fake, harness } = await confirmedApp();
    const first = await rawCall(app, { token }, { name: 'sql_execute', arguments: DELETE });
    const retry = { requestState: requestStateOf(first), answer: ACCEPT };
    const ran = await rawCall(app, { token }, retryParameters('sql_execute', DELETE, retry));
    expect(ran['structuredContent']).toMatchObject({ rows_affected: 3 });
    const replayed = await rawCall(app, { token }, retryParameters('sql_execute', DELETE, retry));
    expect(replayed['structuredContent']).toStrictEqual({
      error: 'confirmation_reused',
      message: ACTION_ERROR_MESSAGES.confirmation_reused,
    });
    expect(fake.opened).toHaveLength(1);
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'accepted',
      'invalid',
    ]);
  });

  it('ACT-45 ACT-76 refuses altered arguments, an edited target, another token and an expired state', async () => {
    const { app, token, issue, fake, harness } = await confirmedApp();
    const pending = await rawCall(app, { token }, { name: 'sql_execute', arguments: DELETE });
    const retry = { requestState: requestStateOf(pending), answer: ACCEPT };
    const altered = await rawCall(
      app,
      { token },
      retryParameters('sql_execute', { ...DELETE, params: ['s-2'] }, retry),
    );
    expect(altered['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const otherToken = await rawCall(
      app,
      { token: issue(WRITE) },
      retryParameters('sql_execute', DELETE, retry),
    );
    expect(otherToken['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const target = harness.engine.targets.list()[0];
    harness.engine.targets.setEnabled(target?.id ?? '', true, OPERATOR_ID);
    const edited = await rawCall(app, { token }, retryParameters('sql_execute', DELETE, retry));
    expect(edited['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const fresh = await rawCall(app, { token }, { name: 'sql_execute', arguments: DELETE });
    await harness.clock.advance(120_000);
    const expired = await rawCall(
      app,
      { token },
      retryParameters('sql_execute', DELETE, {
        requestState: requestStateOf(fresh),
        answer: ACCEPT,
      }),
    );
    expect(expired['structuredContent']).toStrictEqual({
      error: 'confirmation_expired',
      message: ACTION_ERROR_MESSAGES.confirmation_expired,
    });
    expect(fake.opened).toStrictEqual([]);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'denied:confirmation_invalid',
      'denied:confirmation_invalid',
      'denied:confirmation_invalid',
      'denied:confirmation_expired',
    ]);
  });
});

describe('the sql tools through the MCP client SDK', () => {
  it('ACT-14 ACT-18 tools/list advertises both sql tools to a token holding both scopes', async () => {
    const { app, issue } = createActionsApp({
      config: SQL_ON,
      runtime: sqlConnectorOver(fakeSqlSessions()),
    });
    const client = await connectSdkClient(app, { token: issue(WRITE), elicitation: 'none' });
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
    await createSqlTarget(harness, { policy: { ...WRITE_POLICY, confirm_writes: false } });
    const client = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
      elicitation: 'none',
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
    await createSqlTarget(harness, { policy: { ...WRITE_POLICY } });
    const writer = await connectSdkClient(app, { token: issue(WRITE), elicitation: 'none' });
    const both = await writer.callTool({ name: 'actions_list_targets', arguments: {} });
    await writer.close();
    expect(both.structuredContent).toStrictEqual({
      targets: [
        {
          name: 'warehouse',
          description: 'The reporting replica',
          connector: 'sql',
          operations: ['read', 'write'],
          confirm_writes: true,
          engine: 'postgres',
        },
      ],
    });
    const reader = await connectSdkClient(app, {
      token: issue(['actions:sql.read']),
      elicitation: 'none',
    });
    const readOnly = await reader.callTool({ name: 'actions_list_targets', arguments: {} });
    await reader.close();
    expect(readOnly.structuredContent).toMatchObject({ targets: [{ operations: ['read'] }] });
  });
});
