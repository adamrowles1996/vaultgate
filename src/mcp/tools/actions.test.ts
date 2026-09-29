import { describe, expect, it } from 'vitest';

import { ACTION_ERROR_MESSAGES } from '../../actions/errors.ts';
import { createActionsApp, rawCall } from '../../test-support/actions-app.ts';
import {
  CLIENT_ID,
  createHttpTarget,
  OPERATOR_ID,
  OTHER_CLIENT_ID,
  storedCalls,
} from '../../test-support/actions-fixtures.ts';
import {
  callTool,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
} from '../../test-support/mcp-client.ts';
import { TEST_METADATA_URL } from '../../test-support/test-app.ts';
import { insufficientScopeChallenge } from '../challenges.ts';

const MODERN = { protocolVersion: MODERN_PROTOCOL_VERSION } as const;
const POST = { target: 'api', method: 'POST', path: '/v1/items', body: '{"name":"x"}' };

describe('connector tool dispatch', () => {
  it('ACT-11 OAUTH-33 refuses a connector tool without its scope, naming that scope', async () => {
    const { app, issue } = createActionsApp({ config: { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } });
    const outcome = await callTool(
      app,
      'http_request',
      { ...POST, method: 'GET' },
      { token: issue(['actions:sql.read']), ...MODERN },
    );
    expect(outcome.status).toBe(403);
    expect(outcome.headers.get('www-authenticate')).toBe(
      insufficientScopeChallenge(
        TEST_METADATA_URL,
        ['actions:http'],
        'http_request requires actions:http',
      ),
    );
  });

  it('ACT-15 ACT-74 ACT-16 answers every refusal as { error, message, detail? } with isError, in the 13.6.1 order and learning nothing about an ungranted target', async () => {
    const { app, issue, harness } = createActionsApp();
    const token = issue(['actions:http']);
    const unknown = await callTool(
      app,
      'http_request',
      { target: 'nope', method: 'GET', path: '/x' },
      { token, ...MODERN },
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toStrictEqual({
      error: 'unknown_target',
      message: ACTION_ERROR_MESSAGES.unknown_target,
    });
    expect(unknown.contentText).toBe(`unknown_target: ${ACTION_ERROR_MESSAGES.unknown_target}`);
    await createHttpTarget(harness, {
      grantTo: [OTHER_CLIENT_ID],
      policy: { allowed_paths: ['/v1/*'] },
    });
    const ungranted = await callTool(
      app,
      'http_request',
      { target: 'api', method: 'GET', path: '/v2/x' },
      { token, ...MODERN },
    );
    expect(ungranted.structuredContent).toStrictEqual({
      error: 'not_granted',
      message: ACTION_ERROR_MESSAGES.not_granted,
    });
    expect(harness.lookups).toStrictEqual(['api.example.com']);
    const target = harness.engine.targets.list()[0];
    harness.engine.targets.grant(target?.id ?? '', CLIENT_ID, OPERATOR_ID);
    const denied = await callTool(
      app,
      'http_request',
      { target: 'api', method: 'GET', path: '/v2/x' },
      { token, ...MODERN },
    );
    expect(denied.structuredContent).toStrictEqual({
      error: 'policy_denied',
      message: ACTION_ERROR_MESSAGES.policy_denied,
      detail: { reason: 'path' },
    });
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'denied:unknown_target',
      'denied:not_granted',
      'denied:policy_denied',
    ]);
  });

  it('ACT-60 MCP-13 records one audit event per connector call, from the engine, never a second from the route', async () => {
    const { app, issue, harness, audit } = createActionsApp();
    await createHttpTarget(harness);
    const outcome = await callTool(
      app,
      'http_request',
      { target: 'api', method: 'GET', path: '/v1/me' },
      { token: issue(['actions:http']), ...MODERN },
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toMatchObject({
      status: 200,
      truncated: false,
      duration_ms: 0,
    });
    expect(
      audit.events.map((event) => [event.category, event.action, event.outcome]),
    ).toStrictEqual([
      ['actions', 'target_created', 'ok'],
      ['actions', 'grant_added', 'ok'],
      ['mcp', 'http_request', 'ok'],
    ]);
    expect(audit.events[2]).toMatchObject({
      clientId: CLIENT_ID,
      details: { clientName: 'Agent One', target: 'api', outcome: 'ok' },
    });
    expect(audit.events[2]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('MCP-6 validates the composed arguments before the engine sees the call', async () => {
    const { app, issue, harness } = createActionsApp();
    await createHttpTarget(harness);
    const outcome = await callTool(
      app,
      'http_request',
      { target: 'api', method: 'GET' },
      { token: issue(['actions:http']), ...MODERN },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.contentText).toContain('Invalid arguments for tool http_request');
    expect(storedCalls(harness.database)).toStrictEqual([]);
  });
});

async function writable() {
  const fixture = createActionsApp();
  await createHttpTarget(fixture.harness, { policy: { allowed_methods: ['GET', 'POST'] } });
  return { ...fixture, token: fixture.issue(['actions:http']) };
}

describe('writes on the wire', () => {
  it('ACT-40 runs a write at once on the 2026-07-28 wire: the answer is the result, never an input request', async () => {
    const { app, token, harness } = await writable();
    const result = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    expect(result['resultType']).toBe('complete');
    expect(result['isError']).toBeFalsy();
    expect(result['structuredContent']).toMatchObject({ status: 200 });
    expect(harness.connector.contexts).toHaveLength(1);
    expect(storedCalls(harness.database)).toMatchObject([
      { operation: 'write', outcome: 'ok', elicitation: 'not_required' },
    ]);
  });

  it('ACT-40 runs the same write for a client on the 2025 wire, which declares nothing per request', async () => {
    const { app, token, harness } = await writable();
    const outcome = await callTool(app, 'http_request', POST, {
      token,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toMatchObject({ status: 200 });
    expect(storedCalls(harness.database)).toMatchObject([{ operation: 'write', outcome: 'ok' }]);
  });
});
