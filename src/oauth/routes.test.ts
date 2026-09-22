import { describe, expect, it } from 'vitest';

import { createOAuthHarness, formBody, PUBLIC_URL } from '../test-support/oauth-harness.ts';

describe('OAuth routes', () => {
  it('OAUTH-2/OAUTH-3 serves the metadata document as cacheable JSON with permissive CORS', async () => {
    const harness = createOAuthHarness();
    const response = await harness.request('/.well-known/oauth-authorization-server');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const document = (await response.json()) as Record<string, unknown>;
    expect(document['issuer']).toBe(PUBLIC_URL);
    expect(document['token_endpoint']).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(document['scopes_supported']).toStrictEqual(['vault:read', 'vault:reveal', 'vault:generate']);
  });

  it.each(['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/revoke', '/oauth/register'])(
    'OAUTH-37 %s answers a preflight with the MCP header set',
    async (path) => {
      const harness = createOAuthHarness();
      const response = await harness.request(path, {
        method: 'OPTIONS',
        headers: { origin: 'https://agent.example.com', 'access-control-request-method': 'POST' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-headers')).toBe(
        'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
      );
      expect(response.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, Mcp-Session-Id');
    },
  );

  it('OAUTH-37 never sets CORS headers on the cookie-bearing authorize route', async () => {
    const harness = createOAuthHarness();
    const get = await harness.request('/oauth/authorize', { headers: { origin: 'https://agent.example.com' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await harness.request('/oauth/authorize', {
      method: 'OPTIONS',
      headers: { origin: 'https://agent.example.com', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const post = await harness.request('/oauth/authorize', formBody({}));
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the health probes and the JSON 404 of the base app', async () => {
    const harness = createOAuthHarness();
    expect((await harness.request('/healthz')).status).toBe(200);
    expect((await harness.request('/oauth/nothing')).status).toBe(404);
  });
});
