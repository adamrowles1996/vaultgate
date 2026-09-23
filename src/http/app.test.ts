import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY } from '../identity/browser.ts';
import { SCOPES } from '../scopes/registry.ts';
import { createHarness, setUpOperator } from '../test-support/identity-app.ts';
import { callTool, initializeRequest, postJsonRpc } from '../test-support/mcp-client.ts';
import {
  createTestApp,
  READY,
  TEST_METADATA_URL,
  TEST_RESOURCE,
  type TestApp,
  testConfig,
} from '../test-support/test-app.ts';

import type { Readiness } from './app.ts';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function appWithLogSink(readiness: () => Readiness = () => READY): TestApp {
  return createTestApp({ readiness });
}

async function signedInCookie(): Promise<{ identity: TestApp['app']; cookie: string }> {
  const harness = createHarness();
  const { browser } = await setUpOperator(harness);
  const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  return { identity: createTestApp({ identity: harness.identity }).app, cookie };
}

describe('createApp', () => {
  it('answers the liveness probe', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('OPS-4 answers the readiness probe without the vault detail', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('OPS-4 answers 503 naming the failing components when not ready', async () => {
    const vault = { ready: false, configured: false, lastSyncAt: null };
    const { app } = appWithLogSink(() => ({ ready: false, failing: ['store', 'vault'], vault }));
    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      status: 'unavailable',
      failing: ['store', 'vault'],
    });
  });

  it('OPS-4 adds the vault detail to /readyz for a signed-in operator only', async () => {
    const { identity, cookie } = await signedInCookie();
    const signedIn = await identity.request('/readyz', { headers: { cookie } });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toStrictEqual({
      status: 'ok',
      vault: { ready: true, configured: true, lastSyncAt: '2026-09-22T12:00:00.000Z' },
    });
    const stale = await identity.request('/readyz', { headers: { cookie: 'vg_session=nope' } });
    expect(await stale.json()).toStrictEqual({ status: 'ok' });
  });

  it('sets a request id and hardening headers on every response', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/healthz');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: 'not_found' });
  });

  it('ID-24 keeps the JSON 404 for an API client that accepts JSON or sends no Accept', async () => {
    const { app } = appWithLogSink();
    const json = await app.request('/nope', { headers: { accept: 'application/json' } });
    const any = await app.request('/nope', { headers: { accept: '*/*' } });
    const bare = await app.request('/nope');
    for (const response of [json, any, bare]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('content-security-policy')).toBeNull();
      expect(await response.json()).toStrictEqual({ error: 'not_found' });
    }
  });

  it('ID-24 answers a browser with an HTML 404 page under the ID-19 policy', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/nope', { headers: { accept: BROWSER_ACCEPT } });
    const markup = await response.text();
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(markup).toContain('<title>Not found · vaultgate</title>');
    expect(markup).toContain('<link rel="stylesheet" href="/static/vaultgate.css" />');
    expect(markup).toContain('Page not found');
    expect(markup).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    );
    expect(markup).not.toContain('<script');
  });

  it('ID-23 redirects the bare root to login without a session and to the account with one', async () => {
    const { app } = appWithLogSink();
    const anonymous = await app.request('/', { headers: { accept: BROWSER_ACCEPT } });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/login');
    const { identity, cookie } = await signedInCookie();
    const signedIn = await identity.request('/', { headers: { accept: BROWSER_ACCEPT, cookie } });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/account');
  });

  it('leaves /mcp and the metadata routes to their own answers whatever the Accept', async () => {
    const { app } = appWithLogSink();
    const plain = await app.request(TEST_RESOURCE);
    const browser = await app.request(TEST_RESOURCE, { headers: { accept: BROWSER_ACCEPT } });
    for (const response of [plain, browser]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
      expect(response.headers.get('content-security-policy')).toBeNull();
      expect(await response.json()).toMatchObject({ error: 'invalid_token' });
    }
    const metadata = await app.request(TEST_METADATA_URL, { headers: { accept: BROWSER_ACCEPT } });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-type')).toContain('application/json');
  });

  it('ID-20 sends HSTS only when the public URL is https', async () => {
    const secure = await appWithLogSink().app.request('/healthz');
    const plainConfig = testConfig({ VAULTGATE_PUBLIC_URL: 'http://localhost:8080' });
    const plain = await createTestApp({ config: plainConfig }).app.request('/healthz');
    expect(secure.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });

  it('mounts the operator pages and resolves the session cookie', async () => {
    const { app } = appWithLogSink();
    const setup = await app.request('/setup');
    const account = await app.request('/account');
    expect(setup.status).toBe(200);
    expect(setup.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(account.status).toBe(303);
    expect(account.headers.get('location')).toBe('/login?next=%2Faccount');
  });

  it(
    'answers POST /mcp normally when an operator session cookie accompanies the bearer',
    { timeout: 2000 },
    async () => {
      // Reported from a fresh-VM install as a stall with nothing logged; the
      // session middleware runs before /mcp, so both headers travel together here.
      const harness = createHarness();
      const { browser } = await setUpOperator(harness);
      const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      expect(cookie).toContain('__Host-vg_session=');
      const { app, verifier, audit } = createTestApp({ identity: harness.identity });
      const token = verifier.issue({ scopes: [...SCOPES] });
      const handshake = await postJsonRpc(app, initializeRequest(), { token, headers: { cookie } });
      expect(handshake.status).toBe(200);
      expect(handshake.message).toMatchObject({ result: { serverInfo: { name: 'vaultgate' } } });
      const call = await callTool(app, 'vault_status', {}, { token, headers: { cookie } });
      expect(call.status).toBe(200);
      expect(call.isError).toBe(false);
      expect(audit.events.map((event) => event.outcome)).toStrictEqual(['ok']);
    },
  );

  it('logs and masks unhandled errors', async () => {
    const { app, logged } = appWithLogSink();
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    const response = await app.request('/boom');
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({ error: 'internal_error' });
    expect(logged()).toContain('kaboom');
    expect(logged()).toContain('unhandled request error');
  });
});
