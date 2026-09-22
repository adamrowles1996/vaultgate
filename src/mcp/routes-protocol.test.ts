import { describe, expect, it } from 'vitest';

import {
  callTool,
  initializeRequest,
  type JsonRpcRequest,
  LEGACY_PROTOCOL_VERSION,
  listToolNames,
  MODERN_PROTOCOL_VERSION,
  postJsonRpc,
  PROTOCOL_VERSIONS,
  type ProtocolVersion,
  request,
} from '../test-support/mcp-client.ts';
import { createTestApp, TEST_METADATA_URL } from '../test-support/test-app.ts';

import { insufficientScopeChallenge } from './challenges.ts';
import { SCOPES, TOOL_NAMES } from './scopes.ts';

const ALL = [...SCOPES];
const READ_TOOLS = ['vault_status', 'search_items', 'get_item', 'list_folders', 'list_collections'];

/**
The first message of a session: `initialize` on the 2025 format, `server/discover` on 2026-07-28.
*/
function handshake(protocolVersion: ProtocolVersion): JsonRpcRequest {
  return protocolVersion === LEGACY_PROTOCOL_VERSION
    ? initializeRequest(protocolVersion)
    : request('server/discover');
}

const HANDSHAKE_RESULTS: Readonly<Record<ProtocolVersion, unknown>> = {
  [LEGACY_PROTOCOL_VERSION]: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'vaultgate' },
  },
  [MODERN_PROTOCOL_VERSION]: {
    supportedVersions: [MODERN_PROTOCOL_VERSION],
    capabilities: { tools: {} },
  },
};

/**
 * MCP-2: the same surface under both wire formats the SDK serves. The 2025
 * format is the `initialize` handshake; 2026-07-28 carries a `_meta` envelope
 * and the `Mcp-Method` / `Mcp-Name` headers on every request.
 */
describe.each(PROTOCOL_VERSIONS)('POST /mcp speaking protocol %s', (protocolVersion) => {
  it('MCP-2 MCP-8 opens the session with a tools-only capability set', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, handshake(protocolVersion), {
      token,
      protocolVersion,
    });
    expect(response.status).toBe(200);
    expect(response.message).toMatchObject({ result: HANDSHAKE_RESULTS[protocolVersion] });
    expect(JSON.stringify(response.message)).not.toContain('"resources"');
    expect(JSON.stringify(response.message)).not.toContain('"prompts"');
  });

  it('MCP-7 lists only the tools the token may call', async () => {
    const { app, verifier } = createTestApp();
    const readOnly = verifier.issue({ scopes: ['vault:read'] });
    expect(await listToolNames(app, { token: readOnly, protocolVersion })).toStrictEqual(
      READ_TOOLS,
    );
    const everything = verifier.issue({ scopes: ALL });
    expect(await listToolNames(app, { token: everything, protocolVersion })).toStrictEqual([
      ...TOOL_NAMES,
    ]);
  });

  it('MCP-13 calls vault_status and audits the call', async () => {
    const { app, verifier, audit } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    const outcome = await callTool(app, 'vault_status', {}, { token, protocolVersion });
    expect(outcome.status).toBe(200);
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toMatchObject({ state: 'unlocked' });
    expect(audit.events.map((event) => [event.action, event.outcome])).toStrictEqual([
      ['vault_status', 'ok'],
    ]);
  });

  it('OAUTH-33 answers an out-of-scope call with 403, the exact challenge and a denied audit event', async () => {
    const { app, verifier, audit } = createTestApp();
    const token = verifier.issue({ scopes: ['vault:read'] });
    const outcome = await callTool(
      app,
      'get_secret',
      { item_id: 'item-login', field: 'password' },
      { token, protocolVersion },
    );
    expect(outcome.status).toBe(403);
    expect(outcome.headers.get('www-authenticate')).toBe(
      insufficientScopeChallenge(
        TEST_METADATA_URL,
        ['vault:reveal'],
        'get_secret requires vault:reveal',
      ),
    );
    expect(audit.events.map((event) => [event.action, event.outcome])).toStrictEqual([
      ['get_secret', 'denied'],
    ]);
  });
});

describe('POST /mcp speaking protocol 2026-07-28 only', () => {
  it('MCP-2 has no initialize handshake: the SDK answers it as an unknown method', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, initializeRequest(MODERN_PROTOCOL_VERSION), {
      token,
      protocolVersion: MODERN_PROTOCOL_VERSION,
    });
    expect(response.status).toBe(404);
    expect(response.message).toMatchObject({ error: { code: -32_601 } });
  });

  it('MCP-2 rejects a request that names the modern revision without the per-request envelope', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, JSON.stringify(request('tools/list')), {
      token,
      protocolVersion: MODERN_PROTOCOL_VERSION,
    });
    expect(response.status).toBe(400);
    expect(response.message).toMatchObject({
      error: { code: -32_602, data: { envelope: { missing: ['_meta'] } } },
    });
  });

  it('OAUTH-37 rejects a tools/call whose Mcp-Name header disagrees with the body', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const outcome = await callTool(
      app,
      'vault_status',
      {},
      { token, protocolVersion: MODERN_PROTOCOL_VERSION, headers: { 'mcp-name': 'list_folders' } },
    );
    expect(outcome.status).toBe(400);
    expect(outcome.text).toContain('Mcp-Name');
  });
});
