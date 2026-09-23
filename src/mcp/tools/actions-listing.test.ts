import { describe, expect, it } from 'vitest';

import { SCOPES } from '../../scopes/registry.ts';
import { createActionsApp } from '../../test-support/actions-app.ts';
import {
  CLIENT_ID,
  createHttpTarget,
  OTHER_CLIENT_ID,
} from '../../test-support/actions-fixtures.ts';
import {
  callTool,
  listToolNames,
  MODERN_PROTOCOL_VERSION,
  postJsonRpc,
  request,
} from '../../test-support/mcp-client.ts';
import { createTestApp, TEST_METADATA_URL, testConfig } from '../../test-support/test-app.ts';
import { insufficientScopeChallenge } from '../challenges.ts';
import { TOOL_NAMES } from '../scopes.ts';

import { LIST_TARGETS_ANNOTATIONS } from './actions.ts';

const MODERN = { protocolVersion: MODERN_PROTOCOL_VERSION } as const;
const READ_TOOLS = ['vault_status', 'search_items', 'get_item', 'list_folders', 'list_collections'];

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly annotations: Record<string, unknown>;
  readonly inputSchema: {
    readonly properties: Record<string, unknown>;
    readonly required?: string[];
  };
}

async function listedTools(app: ReturnType<typeof createActionsApp>['app'], token: string) {
  const response = await postJsonRpc(app, request('tools/list'), { token, ...MODERN });
  return (response.message as { result: { tools: ListedTool[] } }).result.tools;
}

describe('actions tools in tools/list', () => {
  it('MCP-7 ACT-14 lists actions_list_targets and the connector tools only for the scopes the token holds', async () => {
    const { app, issue } = createActionsApp();
    expect(await listToolNames(app, { token: issue(['vault:read']), ...MODERN })).toStrictEqual(
      READ_TOOLS,
    );
    expect(await listToolNames(app, { token: issue(['actions:http']), ...MODERN })).toStrictEqual([
      'actions_list_targets',
      'http_request',
    ]);
    expect(await listToolNames(app, { token: issue([...SCOPES]), ...MODERN })).toStrictEqual([
      ...TOOL_NAMES,
      'actions_list_targets',
      'http_request',
    ]);
  });

  it('ACT-14 ACT-67 hides a connector tool whose connector is off or not loaded, and the listing when no actions scope is effective', async () => {
    const sqlOnly = createActionsApp({
      config: { VAULTGATE_ACTIONS_ENABLE_HTTP: 'false', VAULTGATE_ACTIONS_ENABLE_SQL: 'true' },
    });
    const token = sqlOnly.issue(['actions:http', 'actions:sql.read']);
    expect(await listToolNames(sqlOnly.app, { token, ...MODERN })).toStrictEqual([
      'actions_list_targets',
    ]);
    const layerOff = createActionsApp({ config: { VAULTGATE_ENABLE_ACTIONS: 'false' } });
    const held = layerOff.issue(['vault:read', 'actions:http']);
    expect(await listToolNames(layerOff.app, { token: held, ...MODERN })).toStrictEqual(READ_TOOLS);
  });

  it('ACT-14 ACT-67 answers a call to a tool no loaded connector serves as an unknown tool', async () => {
    const { app, issue } = createActionsApp({ config: { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' } });
    const token = issue(['actions:http', 'actions:sql.read']);
    const response = await postJsonRpc(
      app,
      request('tools/call', {
        name: 'sql_query',
        arguments: { target: 'db', statement: 'SELECT 1' },
      }),
      { token, ...MODERN },
    );
    expect(response.message).toMatchObject({
      error: { code: -32_602, message: 'Tool sql_query not found' },
    });
  });

  it('ACT-73 registers no actions tool and serves no actions call without an engine', async () => {
    const { app, verifier } = createTestApp({
      config: testConfig({
        VAULTGATE_ENABLE_ACTIONS: 'true',
        VAULTGATE_ACTIONS_ENABLE_HTTP: 'true',
      }),
    });
    const token = verifier.issue({ scopes: ['actions:http'] });
    expect(await listToolNames(app, { token, ...MODERN })).toStrictEqual([]);
    const response = await postJsonRpc(
      app,
      request('tools/call', { name: 'actions_list_targets', arguments: {} }),
      { token, ...MODERN },
    );
    expect(response.message).toMatchObject({ error: { code: -32_602 } });
  });

  it('ACT-18 carries the 13.6.1 annotations exactly, with openWorldHint widened for a connector tool', async () => {
    const { app, issue } = createActionsApp();
    const tools = await listedTools(app, issue(['actions:http']));
    expect(tools.map((tool) => [tool.name, tool.annotations])).toStrictEqual([
      [
        'actions_list_targets',
        {
          title: 'List action targets',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      ],
      [
        'http_request',
        {
          title: 'HTTP request',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      ],
    ]);
    expect(LIST_TARGETS_ANNOTATIONS).toStrictEqual(tools[0]?.annotations);
  });

  it('ACT-17 ACT-16 describes each tool for an LLM and puts target first in every connector tool', async () => {
    const { app, issue } = createActionsApp();
    const tools = await listedTools(app, issue(['actions:http']));
    const [listing, http] = tools;
    expect(listing?.description).toContain('never a secret');
    expect(listing?.description).toContain('pass a name it returned as target');
    expect(http?.description).toContain('actions_list_targets');
    expect(http?.description).toContain('never returns the credential');
    expect(http?.description).toContain('human confirmation');
    expect(Object.keys(http?.inputSchema.properties ?? {})[0]).toBe('target');
    expect(http?.inputSchema.required).toContain('target');
    expect(listing?.inputSchema.properties).toStrictEqual({});
  });
});

describe('actions_list_targets', () => {
  it('ACT-19 MCP-13 lists the granted targets with their operations and audits one event with the operator', async () => {
    const { app, issue, harness, audit } = createActionsApp();
    await createHttpTarget(harness, { policy: { allowed_methods: ['GET', 'POST'] } });
    await createHttpTarget(harness, { name: 'other', grantTo: [OTHER_CLIENT_ID] });
    const outcome = await callTool(
      app,
      'actions_list_targets',
      {},
      { token: issue(['actions:http']), ...MODERN },
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toStrictEqual({
      targets: [
        {
          name: 'api',
          description: 'The example API',
          connector: 'http',
          operations: ['read', 'write'],
          confirm_writes: false,
        },
      ],
    });
    expect(outcome.contentText).toBe(JSON.stringify(outcome.structuredContent));
    expect(outcome.text).not.toContain('api.example.com');
    expect(outcome.text).not.toContain('item-login');
    const recorded = audit.events.filter((event) => event.category === 'mcp');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      category: 'mcp',
      action: 'actions_list_targets',
      outcome: 'ok',
      operatorId: 'operator-1',
      clientId: CLIENT_ID,
      durationMs: 0,
      details: { clientName: 'Agent One' },
    });
  });

  it('ACT-12 OAUTH-33 refuses a token without an actions scope with a challenge naming every enabled actions scope as an any-of set', async () => {
    const { app, issue, audit } = createActionsApp({
      config: { VAULTGATE_ACTIONS_ENABLE_SQL: 'true' },
    });
    const outcome = await callTool(
      app,
      'actions_list_targets',
      {},
      { token: issue(['vault:read']), ...MODERN },
    );
    expect(outcome.status).toBe(403);
    const scopes = ['actions:http', 'actions:sql.read', 'actions:sql.write'] as const;
    const description =
      'actions_list_targets requires any of actions:http actions:sql.read actions:sql.write';
    expect(outcome.headers.get('www-authenticate')).toBe(
      insufficientScopeChallenge(TEST_METADATA_URL, scopes, description),
    );
    expect(audit.events.map((event) => [event.action, event.outcome])).toStrictEqual([
      ['actions_list_targets', 'denied'],
    ]);
    const held = await callTool(
      app,
      'actions_list_targets',
      {},
      { token: issue(['actions:sql.write']), ...MODERN },
    );
    expect(held.status).toBe(200);
    expect(held.structuredContent).toStrictEqual({ targets: [] });
  });
});
