import { describe, expect, it } from 'vitest';

import {
  type Browser,
  cimdDocument,
  createOAuthHarness,
  type OAuthHarness,
  parseConsentForm,
  RESOURCE,
} from '../test-support/oauth-harness.ts';

/**
 * RFC 7636 Appendix B challenge.
 */
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CIMD_ID = 'https://agent.example.com/client.json';
const CIMD_REDIRECT = 'https://agent.example.com/cb';
const DESK = { clientId: 'desk', clientName: 'Desk', redirectUris: ['http://127.0.0.1:4000/cb'] };

function harnessWithClients(): OAuthHarness {
  const harness = createOAuthHarness({ oauthClients: [DESK] });
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT]));
  return harness;
}

function query(overrides: Record<string, string | undefined> = {}): string {
  const parameters: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: CIMD_ID,
    redirect_uri: CIMD_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'vault:read vault:reveal',
    state: 'xyz',
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      search.set(name, value);
    }
  }
  return `/oauth/authorize?${search.toString()}`;
}

async function authorize(harness: OAuthHarness, path: string, browser?: Browser): Promise<Response> {
  return harness.request(path, { headers: browser?.headers ?? {} });
}

describe('GET /oauth/authorize', () => {
  it('OAUTH-17 without a session parks the request, binds a cookie and redirects to login with next=', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query());
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/^\/login\?next=%2Foauth%2Fauthorize%2F[\w-]{43}$/);
    expect(location).not.toContain('code_challenge');
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-vg_authz=[\w-]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const id = decodeURIComponent(location.slice('/login?next='.length)).slice('/oauth/authorize/'.length);
    expect(harness.repos.pendingAuthorizations.find(id)?.parameters).toStrictEqual({
      client_id: CIMD_ID,
      client_name: 'CIMD Agent',
      client_mode: 'cimd',
      loopback_only: '0',
      redirect_uri: CIMD_REDIRECT,
      redirect_host: 'agent.example.com',
      code_challenge: CHALLENGE,
      resource: RESOURCE,
      scope: 'vault:read vault:reveal',
      state: 'xyz',
    });
  });

  it('OAUTH-17 reuses an existing binding cookie and drops the __Host- prefix on plain-http loopback', async () => {
    const harness = createOAuthHarness({ publicUrl: 'http://localhost:8080', oauthClients: [DESK] });
    const first = await harness.request(
      `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'desk', redirect_uri: DESK.redirectUris[0]!, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: 'http://localhost:8080/mcp' }).toString()}`,
    );
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^vg_authz=[\w-]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/);
    const second = await harness.request(
      `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'desk', redirect_uri: DESK.redirectUris[0]!, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: 'http://localhost:8080/mcp' }).toString()}`,
      { headers: { cookie: cookie.split(';')[0]! } },
    );
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(second.status).toBe(302);
  });

  it('OAUTH-17 with a session parks the request and sends the operator straight to the consent page', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const response = await authorize(harness, query(), browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^\/oauth\/authorize\/[\w-]{43}$/);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    [{ client_id: undefined }, 'client_id and redirect_uri are required'],
    [{ redirect_uri: undefined }, 'client_id and redirect_uri are required'],
    [{ redirect_uri: 'http://agent.example.com/cb' }, 'must use https or a loopback http address'],
    [{ client_id: 'nobody' }, 'unknown client_id'],
    [{ redirect_uri: 'https://agent.example.com/other' }, 'redirect_uri is not registered for this client'],
    [{ client_id: 'https://missing.example.com/c.json' }, 'client metadata could not be fetched'],
  ])('OAUTH-14 / T5 renders an error page, never a redirect, for %j', async (overrides, text) => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query(overrides), harness.signIn());
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain(text);
  });

  it('OAUTH-14 renders an error page for a repeated parameter', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, `${query()}&state=again`, harness.signIn());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('parameter &quot;state&quot; is repeated'.replace('&quot;', '&#34;').replace('&quot;', '&#34;'));
  });

  it.each([
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ resource: 'https://other.example.com/mcp' }, 'invalid_target'],
    [{ resource: undefined }, 'invalid_target'],
    [{ scope: 'vault:write' }, 'invalid_scope'],
    [{ scope: 'vault:admin' }, 'invalid_scope'],
  ])('OAUTH-14/15/16 redirects %j back to the trusted client with error, state and iss', async (overrides, error) => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query(overrides), harness.signIn());
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(CIMD_REDIRECT);
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('error_description')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe('https://vault.example.com');
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('OAUTH-16 defaults an absent scope to vault:read and omits state when none was given', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const response = await authorize(harness, query({ scope: undefined, state: undefined }), browser);
    const id = (response.headers.get('location') ?? '').slice('/oauth/authorize/'.length);
    expect(harness.repos.pendingAuthorizations.find(id)?.parameters).toMatchObject({ scope: 'vault:read' });
    expect(harness.repos.pendingAuthorizations.find(id)?.parameters).not.toHaveProperty('state');
  });

  it('OAUTH-7 accepts a loopback literal on another port for a pre-registered client', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query({ client_id: 'desk', redirect_uri: 'http://127.0.0.1:61234/cb' }), harness.signIn());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^\/oauth\/authorize\//);
  });

  it('T22 refetches the CIMD document when the presented redirect is not in the cached copy', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    await authorize(harness, query(), browser);
    harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT, 'https://agent.example.com/new']));
    const response = await authorize(harness, query({ redirect_uri: 'https://agent.example.com/new' }), browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^\/oauth\/authorize\//);
    expect(harness.fetchedUrls).toStrictEqual([CIMD_ID, CIMD_ID]);
  });

  it('§10.4 limits a session to 30 authorization requests per minute and answers 429 with Retry-After', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    for (let index = 0; index < 30; index += 1) {
      expect((await authorize(harness, query(), browser)).status).toBe(302);
    }
    const throttled = await authorize(harness, query(), browser);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('2');
    expect(await throttled.text()).toContain('temporarily_unavailable');
    const anonymous = await authorize(harness, query());
    expect(anonymous.status).toBe(302);
  });
});

describe('GET /oauth/authorize/:id', () => {
  async function parked(harness: OAuthHarness, browser: Browser, overrides: Record<string, string | undefined> = {}): Promise<string> {
    const response = await authorize(harness, query(overrides), browser);
    return response.headers.get('location') ?? '';
  }

  it('OAUTH-13 / OAUTH-18 renders the consent page for the bound browser and never issues a code', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const path = await parked(harness, browser);
    const response = await authorize(harness, path, browser);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const form = parseConsentForm(await response.text());
    expect(form.requestId).toBe(path.slice('/oauth/authorize/'.length));
    expect(form.csrfToken).toBe(browser.session.csrfToken);
    expect(form.html).toContain('<strong>CIMD Agent</strong>');
    expect(form.html).toContain('<code>agent.example.com</code>');
    expect(form.html).toContain('identified by its client metadata document');
    expect(form.html).toContain('<code>vault:reveal</code> <strong class="risk">Sensitive</strong>');
    expect(form.html).not.toContain('class="warning"');
    expect(harness.audit).toStrictEqual([]);
  });

  it('OAUTH-13 / T7 shows the loopback warning and the redirect host with port for a loopback-only client', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const path = await parked(harness, browser, { client_id: 'desk', redirect_uri: 'http://127.0.0.1:61234/cb' });
    const html = await (await authorize(harness, path, browser)).text();
    expect(html).toContain('<p class="warning"><strong>Warning:</strong>');
    expect(html).toContain('loopback address (<code>127.0.0.1:61234</code>)');
    expect(html).toContain('<dt>Will redirect to</dt><dd><code>127.0.0.1:61234</code></dd>');
    expect(html).toContain('pre-registered by the operator');
  });

  it('OAUTH-17 redirects to login when the session is gone, preserving the request id', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const path = await parked(harness, browser);
    const response = await authorize(harness, path);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(path)}`);
  });

  it('OAUTH-17 lets the browser that started without a session claim the request via its binding cookie after login', async () => {
    const harness = harnessWithClients();
    const started = await authorize(harness, query());
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]!;
    const path = decodeURIComponent((started.headers.get('location') ?? '').slice('/login?next='.length));
    const browser = harness.signIn();
    const response = await harness.request(path, { headers: { cookie: `${browser.headers['cookie']}; ${cookie}` } });
    expect(response.status).toBe(200);
    const stranger = await harness.request(path, { headers: harness.signIn().headers });
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain('belongs to another browser');
  });

  it('OAUTH-17 rejects an unknown or expired request id', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const unknown = await authorize(harness, '/oauth/authorize/nope', browser);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('has expired');
    const path = await parked(harness, browser);
    harness.advance(600_000);
    expect((await authorize(harness, path, browser)).status).toBe(400);
  });
});
