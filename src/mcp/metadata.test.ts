import { describe, expect, it } from 'vitest';

import { createTestApp, TEST_PUBLIC_URL } from '../test-support/test-app.ts';

import { resourceUrls } from './metadata.ts';

const PATHS = [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
];

const EXPECTED = {
  resource: `${TEST_PUBLIC_URL}/mcp`,
  authorization_servers: [TEST_PUBLIC_URL],
  scopes_supported: ['vault:read', 'vault:reveal', 'vault:generate', 'vault:write'],
  bearer_methods_supported: ['header'],
  resource_name: 'vaultgate',
  resource_documentation: 'https://github.com/adamrowles1996/vaultgate#readme',
};

describe('protected resource metadata', () => {
  it('§3.1 derives the issuer, canonical resource and metadata URL from the public URL', () => {
    expect(resourceUrls({ publicUrl: TEST_PUBLIC_URL })).toStrictEqual({
      issuer: TEST_PUBLIC_URL,
      resource: `${TEST_PUBLIC_URL}/mcp`,
      metadata: `${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`,
    });
  });

  it.each(PATHS)('OAUTH-1 serves the document at %s', async (path) => {
    const { app } = createTestApp();
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(EXPECTED);
  });

  it.each(PATHS)('OAUTH-3 sets JSON, cache and CORS headers at %s', async (path) => {
    const { app } = createTestApp();
    const response = await app.request(path, { headers: { origin: 'https://agent.example' } });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it.each(PATHS)('OAUTH-37 answers preflight at %s with the exact header list', async (path) => {
    const { app } = createTestApp();
    const response = await app.request(path, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,mcp-protocol-version,mcp-method',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization,Content-Type,Mcp-Session-Id,Mcp-Protocol-Version,Mcp-Method,Mcp-Name',
    );
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'WWW-Authenticate,Mcp-Session-Id',
    );
  });

  it('OAUTH-4 never advertises offline_access', async () => {
    const { app } = createTestApp();
    const response = await app.request('/.well-known/oauth-protected-resource');
    expect(await response.text()).not.toContain('offline_access');
  });
});
