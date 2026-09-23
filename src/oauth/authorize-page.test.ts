import { describe, expect, it } from 'vitest';

import {
  authorize,
  firstCookie,
  harnessWithClients,
  parkedPath,
  query,
  requestIdOf,
} from '../test-support/authorize-fixtures.ts';
import { flattenHtml, parseConsentForm } from '../test-support/oauth-http.ts';

describe('GET /oauth/authorize/:id', () => {
  it('OAUTH-13 / OAUTH-18 renders the consent page for the bound browser and never issues a code', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const path = await parkedPath(harness, browser);
    const response = await authorize(harness, path, browser);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const form = parseConsentForm(response.text);
    expect(form.requestId).toBe(requestIdOf(path));
    expect(form.csrfToken).toBe(browser.session.csrfToken);
    expect(form.html).toContain('<strong>CIMD Agent</strong>');
    expect(form.html).toContain('<code>agent.example.com</code>');
    expect(form.html).toContain('identified by its client metadata document');
    expect(flattenHtml(form.html)).toContain(
      '<code>vault:reveal</code><strong class="risk">Sensitive</strong>',
    );
    expect(form.html).not.toContain('class="warning"');
    expect(harness.audit).toStrictEqual([]);
  });

  it('OAUTH-13 / T7 shows the loopback warning and the redirect host with port for a loopback-only client', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const overrides = { client_id: 'desk', redirect_uri: 'http://127.0.0.1:61234/cb' };
    const path = await parkedPath(harness, browser, overrides);
    const page = await authorize(harness, path, browser);
    const text = flattenHtml(page.text);
    expect(text).toContain('<p class="warning"><strong>Warning:</strong>this client redirects');
    expect(text).toContain('loopback address (<code>127.0.0.1:61234</code>)');
    expect(text).toContain('<dt>Will redirect to</dt><dd><code>127.0.0.1:61234</code></dd>');
    expect(text).toContain('pre-registered by the operator');
  });

  it('OAUTH-17 redirects to login when the session is gone, preserving the request id', async () => {
    const harness = harnessWithClients();
    const path = await parkedPath(harness, harness.signIn());
    const response = await authorize(harness, path);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(path)}`);
  });

  it('OAUTH-17 lets the browser that started without a session claim the request via its binding cookie after login', async () => {
    const harness = harnessWithClients();
    const started = await authorize(harness, query());
    const next = (started.headers.get('location') ?? '').slice('/login?next='.length);
    const path = decodeURIComponent(next);
    const browser = harness.signIn();
    const cookie = `${browser.headers['cookie'] ?? ''}; ${firstCookie(started)}`;
    const response = await harness.exchange(path, { headers: { cookie } });
    expect(response.status).toBe(200);
    const stranger = await authorize(harness, path, harness.signIn());
    expect(stranger.status).toBe(403);
    expect(stranger.text).toContain('belongs to another browser');
  });

  it('OAUTH-17 rejects an unknown or expired request id', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const unknown = await authorize(harness, '/oauth/authorize/nope', browser);
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('has expired');
    const path = await parkedPath(harness, browser);
    harness.advance(600_000);
    const expired = await authorize(harness, path, browser);
    expect(expired.status).toBe(400);
  });
});
