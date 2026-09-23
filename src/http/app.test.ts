import { describe, expect, it } from 'vitest';

import { SCOPES } from '../mcp/scopes.ts';
import { createHarness, setUpOperator } from '../test-support/identity-app.ts';
import { callTool, initializeRequest, postJsonRpc } from '../test-support/mcp-client.ts';
import { createTestApp, type TestApp, testConfig } from '../test-support/test-app.ts';

import type { Readiness } from './app.ts';

const READY: Readiness = { ready: true, failing: [] };

function appWithLogSink(readiness: () => Readiness = () => READY): TestApp {
  return createTestApp({ readiness });
}

describe('createApp', () => {
  it('answers the liveness probe', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('answers the readiness probe', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('OPS-4 answers 503 naming the failing components when not ready', async () => {
    const { app } = appWithLogSink(() => ({ ready: false, failing: ['store'] }));
    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ status: 'unavailable', failing: ['store'] });
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
