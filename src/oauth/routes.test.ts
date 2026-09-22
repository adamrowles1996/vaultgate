import { describe, expect, it } from 'vitest';

import { createOAuthHarness, PUBLIC_URL } from '../test-support/oauth-harness.ts';
import { formBody, parseJson } from '../test-support/oauth-http.ts';

const PREFLIGHT: RequestInit = {
  method: 'OPTIONS',
  headers: { origin: 'https://agent.example.com', 'access-control-request-method': 'POST' },
};

describe('OAuth routes', () => {
  it('OAUTH-2/OAUTH-3 serves the metadata document as cacheable JSON with permissive CORS', async () => {
    const harness = createOAuthHarness();
    const response = await harness.exchange('/.well-known/oauth-authorization-server');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const document = parseJson(response);
    expect(document['issuer']).toBe(PUBLIC_URL);
    expect(document['token_endpoint']).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(document['scopes_supported']).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
  });

  it.each([
    '/.well-known/oauth-authorization-server',
    '/oauth/token',
    '/oauth/revoke',
    '/oauth/register',
  ])('OAUTH-37 %s answers a preflight with the exact MCP header list', async (path) => {
    const harness = createOAuthHarness();
    const response = await harness.exchange(path, PREFLIGHT);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')?.split(',')).toStrictEqual([
      'Authorization',
      'Content-Type',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'Mcp-Method',
      'Mcp-Name',
    ]);
    expect(response.headers.get('access-control-expose-headers')?.split(',')).toStrictEqual([
      'WWW-Authenticate',
      'Mcp-Session-Id',
    ]);
  });

  it('OAUTH-37 never sets CORS headers on the cookie-bearing authorize route', async () => {
    const harness = createOAuthHarness();
    const get = await harness.exchange('/oauth/authorize', {
      headers: { origin: 'https://agent.example.com' },
    });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await harness.exchange('/oauth/authorize', PREFLIGHT);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const post = await harness.exchange('/oauth/authorize', formBody({}));
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the health probes, the protected resource metadata and the JSON 404 of the base app', async () => {
    const harness = createOAuthHarness();
    const health = await harness.exchange('/healthz');
    expect(health.status).toBe(200);
    const prm = await harness.exchange('/.well-known/oauth-protected-resource/mcp');
    expect(parseJson(prm)['authorization_servers']).toStrictEqual([PUBLIC_URL]);
    const missing = await harness.exchange('/oauth/nothing');
    expect(missing.status).toBe(404);
  });
});
