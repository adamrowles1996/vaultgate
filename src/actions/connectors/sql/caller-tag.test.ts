import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { connectSdkClient, createActionsApp } from '../../../test-support/actions-app.ts';
import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import { fakeSqlSessions, rowsOf } from '../../../test-support/fake-sql-session.ts';
import { MODERN_PROTOCOL_VERSION, postJsonRpc, request } from '../../../test-support/mcp-client.ts';
import {
  createSqlTarget,
  sqlConnectorOver,
  WRITE_POLICY,
} from '../../../test-support/sql-connector.ts';

import type { ActionsApp } from '../../../test-support/actions-app.ts';
import type { FakeSessions } from '../../../test-support/fake-sql-session.ts';

const SQL_ON = { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } as const;
const TAG = /^vg:Agent-One:operator:t=[0-9a-f]{12}$/u;

function appOver(fake: FakeSessions): ActionsApp {
  return createActionsApp({ config: SQL_ON, runtime: sqlConnectorOver(fake) });
}

function tokenIdOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

describe('the caller tag from the MCP request to the database and the Writes row', () => {
  it('ACT-131 ACT-132 ACT-133 (iv) a request carrying an Authorization header tags the statement and the row with the token id, never the token', async () => {
    const fake = fakeSqlSessions({ answers: [rowsOf(['n'], [[1]])] });
    const { app, harness, issue, audit } = appOver(fake);
    await createSqlTarget(harness, { policy: WRITE_POLICY });
    const token = issue(['actions:sql.read', 'actions:sql.write']);
    const client = await connectSdkClient(app, { token });
    const result = await client.callTool({
      name: 'sql_execute',
      arguments: { target: 'warehouse', statement: 'DELETE FROM t WHERE id = $1', params: [1] },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    const tag = fake.requests[0]?.callerTag;
    expect(tag).toMatch(TAG);
    expect(tag).toBe(`vg:Agent-One:operator:t=${tokenIdOf(token)}`);
    const [row] = storedCalls(harness.database);
    expect(row).toMatchObject({ tool: 'sql_execute', operation: 'write', callerTag: tag });
    const event = audit.events.findLast((entry) => entry.action === 'sql_execute');
    expect(event?.details).toMatchObject({ callerTag: tag });
    for (const recorded of [tag, JSON.stringify(row), JSON.stringify(event)]) {
      expect(recorded).not.toContain(token);
      expect(recorded).not.toContain(`Bearer ${token}`);
    }
  });

  it('ACT-131 an Mcp-Session-Id header makes the tag name the session, by hash', async () => {
    const fake = fakeSqlSessions({ answers: [rowsOf(['n'], [[1]])] });
    const { app, harness, issue } = appOver(fake);
    await createSqlTarget(harness);
    const token = issue(['actions:sql.read']);
    const session = 'mcp-session-4f2c9e';
    const call = request('tools/call', {
      name: 'sql_query',
      arguments: { target: 'warehouse', statement: 'SELECT 1' },
    });
    const response = await postJsonRpc(app, call, {
      token,
      protocolVersion: MODERN_PROTOCOL_VERSION,
      headers: { 'Mcp-Session-Id': session },
    });
    expect(response.status).toBe(200);
    const hashed = createHash('sha256').update(session).digest('hex').slice(0, 12);
    const tag = fake.requests[0]?.callerTag;
    expect(tag).toBe(`vg:Agent-One:operator:t=${tokenIdOf(token)}:s=${hashed}`);
    expect(tag).not.toContain(session);
    expect(storedCalls(harness.database)[0]?.callerTag).toBe(tag);
  });

  it('RELAY-17 ACT-131 ACT-133 a relay token names its node in the statement, the row and the audit event, never the token', async () => {
    const fake = fakeSqlSessions({ answers: [rowsOf(['n'], [[1]])] });
    const { app, harness, issue, audit } = appOver(fake);
    await createSqlTarget(harness, { policy: WRITE_POLICY });
    const token = issue(
      ['actions:sql.read', 'actions:sql.write'],
      undefined,
      'claude-cloud-sandbox-one.example.ts.net',
    );
    const client = await connectSdkClient(app, { token });
    const result = await client.callTool({
      name: 'sql_execute',
      arguments: { target: 'warehouse', statement: 'DELETE FROM t WHERE id = $1', params: [1] },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    const tag = fake.requests[0]?.callerTag;
    expect(tag).toBe(`vg:Agent-One:operator:t=${tokenIdOf(token)}:n=claude-cloud-sandbox-one`);
    const [row] = storedCalls(harness.database);
    expect(row).toMatchObject({ tool: 'sql_execute', callerTag: tag });
    const event = audit.events.findLast((entry) => entry.action === 'sql_execute');
    expect(event?.details).toMatchObject({ callerTag: tag });
    for (const recorded of [tag, JSON.stringify(row), JSON.stringify(event)]) {
      expect(recorded).not.toContain(token);
    }
  });
});
