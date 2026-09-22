import { describe, expect, it } from 'vitest';

import { initializeRequest, mcpHeaders, postJsonRpc, request } from '../test-support/mcp-client.ts';
import { createTestApp, TEST_METADATA_URL, testConfig } from '../test-support/test-app.ts';

import { invalidTokenChallenge, missingTokenChallenge } from './challenges.ts';
import { SCOPES } from './scopes.ts';

const ALL = [...SCOPES];

describe('POST /mcp bearer handling', () => {
  it('§2.3.1 answers a request without a token with the first-contact challenge', async () => {
    const { app } = createTestApp();
    const response = await postJsonRpc(app, initializeRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(missingTokenChallenge(TEST_METADATA_URL));
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'WWW-Authenticate,Mcp-Session-Id',
    );
  });

  it('OAUTH-32 answers an unknown token with the invalid_token challenge, byte-exact', async () => {
    const { app } = createTestApp();
    const response = await postJsonRpc(app, initializeRequest(), { token: 'vg_at_nope' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(invalidTokenChallenge(TEST_METADATA_URL));
    expect(response.message).toStrictEqual({
      error: 'invalid_token',
      error_description: 'unknown token',
    });
  });

  it('OAUTH-31 rejects a token in the query string with 400 even when the header is valid', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await app.request('/mcp?access_token=vg_at_x', {
      method: 'POST',
      headers: mcpHeaders(token),
      body: JSON.stringify(initializeRequest()),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: 'invalid_request',
      error_description: 'send the token in the Authorization header',
    });
  });

  it('OAUTH-31 applies bearer verification to GET and DELETE as well', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const anonymous = await app.request('/mcp', { method: 'GET', headers: mcpHeaders(undefined) });
    expect(anonymous.status).toBe(401);
    const get = await app.request('/mcp', { method: 'GET', headers: mcpHeaders(token) });
    expect(get.status).toBe(405);
    const remove = await app.request('/mcp', { method: 'DELETE', headers: mcpHeaders(token) });
    expect(remove.status).toBe(405);
  });
});

describe('POST /mcp transport guards', () => {
  it('MCP-3 rejects a foreign Origin with 403 before touching the token', async () => {
    const { app } = createTestApp();
    const response = await postJsonRpc(app, initializeRequest(), {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.message).toStrictEqual({
      error: 'forbidden',
      error_description: 'origin not allowed',
    });
  });

  it('MCP-3 rejects a Host that is not the public host unless a trusted proxy forwards it', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const direct = await postJsonRpc(app, initializeRequest(), {
      token,
      headers: { host: 'internal:8080' },
    });
    expect(direct.status).toBe(403);
    const untrusted = await postJsonRpc(app, initializeRequest(), {
      token,
      headers: { host: 'internal:8080', 'x-forwarded-host': 'vault.example.com' },
    });
    expect(untrusted.status).toBe(403);
    const proxied = createTestApp({ config: testConfig({ VAULTGATE_TRUST_PROXY: 'true' }) });
    const proxiedToken = proxied.verifier.issue({ scopes: ALL });
    const trusted = await postJsonRpc(proxied.app, initializeRequest(), {
      token: proxiedToken,
      headers: { host: 'internal:8080', 'x-forwarded-host': 'vault.example.com' },
    });
    expect(trusted.status).toBe(200);
  });

  it('MCP-4 rejects a body over 256 KiB with 413', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const padding = 'x'.repeat(256 * 1024 + 1);
    const response = await postJsonRpc(app, { ...initializeRequest(), padding }, { token });
    expect(response.status).toBe(413);
    expect(response.message).toStrictEqual({ error: 'payload_too_large' });
  });

  it('OAUTH-37 answers preflight on /mcp with the exact header list, 2026-07-28 headers included', async () => {
    const { app } = createTestApp();
    const response = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-method,mcp-name',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization,Content-Type,Mcp-Session-Id,Mcp-Protocol-Version,Mcp-Method,Mcp-Name',
    );
    expect(response.headers.get('access-control-allow-methods')).toBe('POST,GET,DELETE,OPTIONS');
  });

  it('passes a body that is not JSON through to the SDK, which answers 400', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const response = await postJsonRpc(app, '{not json', { token });
    expect(response.status).toBe(400);
  });

  it('reports SDK-rejected exchanges through the logger without failing the request', async () => {
    const { app, verifier, logged } = createTestApp();
    const token = verifier.issue({ scopes: ALL });
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const response = await postJsonRpc(app, request('tools/list', { _meta: envelope }), {
      token,
      headers: { 'mcp-protocol-version': '2026-07-28' },
    });
    expect(response.status).toBe(400);
    expect(logged()).toContain('mcp handler error');
  });
});
