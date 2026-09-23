import { describe, expect, it } from 'vitest';

import {
  callTool,
  initializeRequest,
  listToolNames,
  postJsonRpc,
  request,
} from '../test-support/mcp-client.ts';
import { createTestApp, TEST_METADATA_URL, testConfig } from '../test-support/test-app.ts';
import { CANARIES } from '../test-support/vault-fixture.ts';

import { insufficientScopeChallenge } from './challenges.ts';
import { SCOPES, TOOL_NAMES } from './scopes.ts';

const ALL = [...SCOPES];
const SOCKET = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };

describe('POST /mcp protocol surface', () => {
  it('MCP-2 and MCP-8 initialises with the legacy protocol version and a tools-only capability set', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, initializeRequest(), { token });
    expect(response.status).toBe(200);
    expect(response.message).toMatchObject({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'vaultgate' },
      },
    });
    expect(JSON.stringify(response.message)).not.toContain('"resources"');
    expect(JSON.stringify(response.message)).not.toContain('"prompts"');
  });

  it('MCP-7 lists only the tools the token may call', async () => {
    const { app, verifier } = createTestApp();
    const readOnly = verifier.issue({ scopes: ['vault:read'] });
    expect(await listToolNames(app, { token: readOnly })).toStrictEqual([
      'vault_status',
      'search_items',
      'get_item',
      'list_folders',
      'list_collections',
    ]);
    const everything = verifier.issue({ scopes: ALL });
    expect(await listToolNames(app, { token: everything })).toStrictEqual([...TOOL_NAMES]);
    const nothing = verifier.issue({ scopes: [] });
    expect(await listToolNames(app, { token: nothing })).toStrictEqual([]);
  });

  it('OAUTH-16 hides write tools when the operator has not enabled vault:write', async () => {
    const { app, verifier } = createTestApp({
      config: testConfig({ VAULTGATE_ENABLE_WRITE_SCOPE: 'false' }),
    });
    const token = verifier.issue({ scopes: ALL });
    const names = await listToolNames(app, { token });
    expect(names).not.toContain('create_item');
    expect(names).toContain('get_secret');
    const outcome = await callTool(app, 'trash_item', { item_id: 'item-login' }, { token });
    expect(outcome.status).toBe(403);
  });

  it('MCP-6 every listed tool declares input and output schemas and an LLM-facing description', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, request('tools/list'), { token });
    const { tools } = (response.message as { result: { tools: Record<string, unknown>[] } }).result;
    expect(tools).toHaveLength(TOOL_NAMES.length);
    expect(
      tools.every(
        (tool) =>
          typeof tool['inputSchema'] === 'object' && typeof tool['outputSchema'] === 'object',
      ),
    ).toBe(true);
    expect(tools.every((tool) => String(tool['description']).length > 80)).toBe(true);
  });

  it('answers a call to an unknown tool with a JSON-RPC invalid-params error', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(
      app,
      request('tools/call', { name: 'drop_vault', arguments: {} }),
      { token },
    );
    expect(response.status).toBe(200);
    expect(response.message).toMatchObject({
      error: { code: -32_602, message: 'Tool drop_vault not found' },
    });
  });

  it('MCP-6 validates arguments against the input schema before the tool runs', async () => {
    const { app, verifier, audit } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const outcome = await callTool(app, 'get_item', { item_id: 7 }, { token });
    expect(outcome.status).toBe(200);
    expect(outcome.isError).toBe(true);
    expect(outcome.contentText).toContain('Invalid arguments for tool get_item');
    expect(audit.events).toStrictEqual([]);
  });
});

describe('POST /mcp scope gate and rate limit', () => {
  it('OAUTH-33 answers an out-of-scope call with 403, the exact challenge and a denied audit event', async () => {
    const { app, verifier, audit } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    const outcome = await callTool(
      app,
      'get_secret',
      { item_id: 'item-login', field: 'password' },
      { token, env: SOCKET },
    );
    expect(outcome.status).toBe(403);
    expect(outcome.headers.get('www-authenticate')).toBe(
      insufficientScopeChallenge(
        TEST_METADATA_URL,
        ['vault:reveal'],
        'get_secret requires vault:reveal',
      ),
    );
    expect(outcome.text).not.toContain(CANARIES[0] ?? '');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toStrictEqual({
      category: 'mcp',
      action: 'get_secret',
      outcome: 'denied',
      operatorId: 'operator-1',
      clientId: 'https://agent.example/client.json',
      tokenPrefix: audit.events[0]?.tokenPrefix,
      requestId: audit.events[0]?.requestId,
      ip: '10.0.0.7',
      durationMs: 0,
      details: { clientName: 'Example Agent' },
    });
  });

  it('OAUTH-33 names every missing scope in one challenge for an explicit password update', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    const outcome = await callTool(
      app,
      'update_item',
      { item_id: 'item-login', password: 'new-pw' },
      { token },
    );
    expect(outcome.status).toBe(403);
    expect(outcome.headers.get('www-authenticate')).toBe(
      insufficientScopeChallenge(
        TEST_METADATA_URL,
        ['vault:write', 'vault:reveal'],
        'update_item requires vault:write vault:reveal',
      ),
    );
  });

  it('MCP-5 allows 120 tool calls per minute per token, then answers 429 with Retry-After', async () => {
    const { app, verifier, clock } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    const other = verifier.issue({ scopes: ['vault:read'] });
    const statuses = new Set<number>();
    for (let call = 0; call < 120; call += 1) {
      const outcome = await callTool(app, 'list_folders', {}, { token });
      statuses.add(outcome.status);
    }
    expect([...statuses]).toStrictEqual([200]);
    clock.advance(30_000);
    const limited = await callTool(app, 'list_folders', {}, { token });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    const unaffected = await callTool(app, 'list_folders', {}, { token: other });
    expect(unaffected.status).toBe(200);
    clock.advance(30_000);
    const renewed = await callTool(app, 'list_folders', {}, { token });
    expect(renewed.status).toBe(200);
  });

  it('MCP-5 counts tool calls only, not listing or initialisation', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    for (let call = 0; call < 121; call += 1) {
      await postJsonRpc(app, request('tools/list'), { token });
    }
    const outcome = await callTool(app, 'list_folders', {}, { token });
    expect(outcome.status).toBe(200);
  });
});

describe('POST /mcp audit', () => {
  it('MCP-13 records one event per call with identity, outcome, item, field, duration and source', async () => {
    const { app, verifier, audit } = createTestApp();
    const token = verifier.issue({
      scopes: ALL,
      clientId: 'vg_c_abc',
      clientName: 'Cowork',
      subject: 'op-9',
    });
    await callTool(
      app,
      'get_secret',
      { item_id: 'item-login', field: 'password' },
      { token, env: SOCKET },
    );
    await callTool(app, 'get_item', { item_id: 'missing' }, { token });
    await callTool(app, 'list_folders', {}, { token });
    expect(
      audit.events.map((event) => [
        event.action,
        event.outcome,
        event.itemId,
        event.field,
        event.ip,
      ]),
    ).toStrictEqual([
      ['get_secret', 'ok', 'item-login', 'password', '10.0.0.7'],
      ['get_item', 'error:not_found', 'missing', undefined, 'unknown'],
      ['list_folders', 'ok', undefined, undefined, 'unknown'],
    ]);
    expect(audit.events[0]).toMatchObject({
      category: 'mcp',
      clientId: 'vg_c_abc',
      operatorId: 'op-9',
      details: { clientName: 'Cowork' },
      durationMs: 0,
    });
    expect(audit.events[0]?.tokenPrefix).toMatch(/^[0-9a-f]{12}$/);
    expect(audit.events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('OPS-6 attributes the source to X-Forwarded-For only behind a trusted proxy', async () => {
    const proxied = createTestApp({ config: testConfig({ VAULTGATE_TRUST_PROXY: 'true' }) });
    const token = proxied.verifier.issue({ scopes: ALL });
    await callTool(
      proxied.app,
      'list_folders',
      {},
      { token, env: SOCKET, headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' } },
    );
    expect(proxied.audit.events[0]?.ip).toBe('203.0.113.9');
  });

  it('MCP-13 never puts arguments, results, the bearer token or a canary in an audit event or log line', async () => {
    const { app, verifier, audit, logged } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    await callTool(app, 'get_secret', { item_id: 'item-login', field: 'password' }, { token });
    await callTool(
      app,
      'create_item',
      { type: 'login', name: 'Fresh', password: 'explicit-secret-value' },
      { token },
    );
    const trail = JSON.stringify(audit.events) + logged();
    expect(trail).not.toContain(token);
    expect(trail).not.toContain('explicit-secret-value');
    expect(CANARIES.filter((canary) => trail.includes(canary))).toStrictEqual([]);
  });

  it('uses the wall clock when no clock is injected', async () => {
    const { app, verifier, audit } = createTestApp({ withClock: false });
    const token = verifier.issue({ scopes: ALL });
    await callTool(app, 'list_folders', {}, { token });
    expect(audit.events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
