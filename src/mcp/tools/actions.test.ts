import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ACTION_ERROR_MESSAGES } from '../../actions/errors.ts';
import { createActionsApp, rawCall, requestStateOf } from '../../test-support/actions-app.ts';
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

import { elicitationCapability } from './actions-call.ts';

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
      details: { clientName: 'Agent One', target: 'api', elicitation: 'not_required' },
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

const declared = (elicitation: unknown): unknown => ({
  params: { _meta: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation } } },
});

async function confirmed() {
  const fixture = createActionsApp();
  await createHttpTarget(fixture.harness, {
    policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
  });
  return { ...fixture, token: fixture.issue(['actions:http']) };
}

describe('elicitation capability and retry on the wire', () => {
  it('ACT-42 ACT-48 answers a form-capable 2026-07-28 client with exactly the elicitation document and the requestState', async () => {
    const { app, token, harness } = await confirmed();
    const result = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    expect(result['resultType']).toBe('input_required');
    expect(result['inputRequests']).toStrictEqual({
      confirm: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message:
            'vaultgate: Agent One asks to run http_request on target "api" (http, api.example.com/v1).\n\n' +
            'POST /v1/items\n\n' +
            'Allow this one call? It expires in 2 minutes and cannot be reused.',
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: 'Allow this call',
                description: 'Tick to let vaultgate run the operation shown above, once.',
                default: false,
              },
            },
            required: ['confirm'],
          },
        },
      },
    });
    expect(requestStateOf(result)).toMatch(/^[\w-]+\.[\w-]{43}$/);
    expect(storedCalls(harness.database)).toStrictEqual([]);
  });

  it('ACT-48 treats an empty elicitation object as form mode and a url-only one, or none, as no elicitation', async () => {
    const { app, token } = await confirmed();
    const empty = await rawCall(
      app,
      { token, clientCapabilities: { elicitation: {} } },
      { name: 'http_request', arguments: POST },
    );
    expect(empty['resultType']).toBe('input_required');
    const urlOnly = await rawCall(
      app,
      { token, clientCapabilities: { elicitation: { url: {} } } },
      { name: 'http_request', arguments: POST },
    );
    expect(urlOnly['structuredContent']).toStrictEqual({
      error: 'confirmation_unavailable',
      message: ACTION_ERROR_MESSAGES.confirmation_unavailable,
    });
    const undeclared = await rawCall(
      app,
      { token, clientCapabilities: {} },
      { name: 'http_request', arguments: POST },
    );
    expect(undeclared['isError']).toBe(true);
  });

  it('ACT-48 reads only a plain elicitation object from the envelope; the legacy wire declares nothing per request', () => {
    expect(elicitationCapability(declared({ form: { applyDefaults: true } }))).toBe('form');
    expect(elicitationCapability(declared({}))).toBe('form');
    expect(elicitationCapability(declared([]))).toBe('none');
    expect(elicitationCapability(declared('form'))).toBe('none');
    expect(elicitationCapability(declared(null))).toBe('none');
    expect(elicitationCapability({ params: { name: 'http_request' } })).toBe('none');
    expect(elicitationCapability(undefined)).toBe('none');
  });

  it('ACT-48 refuses a 2025-wire client, whose capabilities the stateless handler never sees, with the fixed message', async () => {
    const { app, token, harness } = await confirmed();
    const outcome = await callTool(app, 'http_request', POST, {
      token,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });
    expect(outcome.structuredContent).toStrictEqual({
      error: 'confirmation_unavailable',
      message: ACTION_ERROR_MESSAGES.confirmation_unavailable,
    });
    expect(harness.lookups).toStrictEqual(['api.example.com']);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:confirmation_unavailable' },
    ]);
  });

  it('ACT-45 asks again when a retry echoes the state without a well-formed answer, running nothing', async () => {
    const { app, token, harness } = await confirmed();
    const first = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    const requestState = requestStateOf(first);
    const noAnswer = await rawCall(
      app,
      { token },
      { name: 'http_request', arguments: POST, requestState },
    );
    expect(noAnswer['resultType']).toBe('input_required');
    expect(requestStateOf(noAnswer)).not.toBe(requestState);
    const malformed = await rawCall(
      app,
      { token },
      {
        name: 'http_request',
        arguments: POST,
        requestState,
        inputResponses: { confirm: { action: 'approve' } },
      },
    );
    expect(malformed['resultType']).toBe('input_required');
    expect(storedCalls(harness.database)).toStrictEqual([]);
    expect(harness.connector.contexts).toStrictEqual([]);
  });
});
