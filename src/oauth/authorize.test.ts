import { describe, expect, it } from 'vitest';

import {
  type Browser,
  cimdDocument,
  createOAuthHarness,
  type Exchange,
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
const LOOPBACK_REDIRECT = 'http://127.0.0.1:4000/cb';
const DESK = { clientId: 'desk', clientName: 'Desk', redirectUris: [LOOPBACK_REDIRECT] };
const CONSENT_PATH = /^\/oauth\/authorize\/[\w-]{43}$/;

type Overrides = Readonly<Record<string, string | undefined>>;

function harnessWithClients(): OAuthHarness {
  const harness = createOAuthHarness({ oauthClients: [DESK] });
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT]));
  return harness;
}

function query(overrides: Overrides = {}, resource = RESOURCE): string {
  const parameters: Overrides = {
    response_type: 'code',
    client_id: CIMD_ID,
    redirect_uri: CIMD_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource,
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

function authorize(harness: OAuthHarness, path: string, browser?: Browser): Promise<Exchange> {
  return harness.exchange(path, { headers: browser?.headers ?? {} });
}

async function parkedPath(
  harness: OAuthHarness,
  browser: Browser,
  overrides: Overrides = {},
): Promise<string> {
  const response = await authorize(harness, query(overrides), browser);
  return response.headers.get('location') ?? '';
}

function requestIdOf(path: string): string {
  return path.slice('/oauth/authorize/'.length);
}

function firstCookie(response: Exchange): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
}

describe('GET /oauth/authorize', () => {
  it('OAUTH-17 without a session parks the request, binds a cookie and redirects to login with next=', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query());
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/^\/login\?next=%2Foauth%2Fauthorize%2F[\w-]{43}$/);
    expect(location).not.toContain('code_challenge');
    expect(response.headers.get('set-cookie')).toMatch(
      /^__Host-vg_authz=[\w-]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const id = requestIdOf(decodeURIComponent(location.slice('/login?next='.length)));
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
    const harness = createOAuthHarness({
      publicUrl: 'http://localhost:8080',
      oauthClients: [DESK],
    });
    const path = query(
      { client_id: 'desk', redirect_uri: LOOPBACK_REDIRECT },
      'http://localhost:8080/mcp',
    );
    const first = await authorize(harness, path);
    expect(first.headers.get('set-cookie')).toMatch(
      /^vg_authz=[\w-]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    const second = await harness.exchange(path, { headers: { cookie: firstCookie(first) } });
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(second.status).toBe(302);
  });

  it('OAUTH-17 with a session parks the request and sends the operator straight to the consent page', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query(), harness.signIn());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(CONSENT_PATH);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    [{ client_id: undefined }, 'client_id and redirect_uri are required'],
    [{ redirect_uri: undefined }, 'client_id and redirect_uri are required'],
    [{ redirect_uri: 'http://agent.example.com/cb' }, 'must use https or a loopback http address'],
    [{ client_id: 'nobody' }, 'unknown client_id'],
    [
      { redirect_uri: 'https://agent.example.com/other' },
      'redirect_uri is not registered for this client',
    ],
    [{ client_id: 'https://missing.example.com/c.json' }, 'client metadata could not be fetched'],
  ])('OAUTH-14 / T5 renders an error page, never a redirect, for %j', async (overrides, text) => {
    const harness = harnessWithClients();
    const response = await authorize(harness, query(overrides), harness.signIn());
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.text).toContain(text);
  });

  it('OAUTH-14 renders an error page for a repeated parameter', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, `${query()}&state=again`, harness.signIn());
    expect(response.status).toBe(400);
    expect(response.text).toContain('parameter &#34;state&#34; is repeated');
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
  ])(
    'OAUTH-14/15/16 redirects %j back to the trusted client with error, state and iss',
    async (overrides, error) => {
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
    },
  );

  it('OAUTH-16 defaults an absent scope to vault:read and omits state when none was given', async () => {
    const harness = harnessWithClients();
    const path = await parkedPath(harness, harness.signIn(), {
      scope: undefined,
      state: undefined,
    });
    const pending = harness.repos.pendingAuthorizations.find(requestIdOf(path));
    expect(pending?.parameters).toMatchObject({ scope: 'vault:read' });
    expect(pending?.parameters).not.toHaveProperty('state');
  });

  it('OAUTH-7 accepts a loopback literal on another port for a pre-registered client', async () => {
    const harness = harnessWithClients();
    const overrides = { client_id: 'desk', redirect_uri: 'http://127.0.0.1:61234/cb' };
    const response = await authorize(harness, query(overrides), harness.signIn());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(CONSENT_PATH);
  });

  it('T22 refetches the CIMD document when the presented redirect is not in the cached copy', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    await authorize(harness, query(), browser);
    harness.cimd.set(
      CIMD_ID,
      cimdDocument(CIMD_ID, [CIMD_REDIRECT, 'https://agent.example.com/new']),
    );
    const overrides = { redirect_uri: 'https://agent.example.com/new' };
    const response = await authorize(harness, query(overrides), browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(CONSENT_PATH);
    expect(harness.fetchedUrls).toStrictEqual([CIMD_ID, CIMD_ID]);
  });

  it('§10.4 limits a session to 30 authorization requests per minute and answers 429 with Retry-After', async () => {
    const harness = harnessWithClients();
    const browser = harness.signIn();
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const response = await authorize(harness, query(), browser);
      statuses.push(response.status);
    }
    expect(statuses).toStrictEqual([...Array.from({ length: 30 }, () => 302), 429]);
    const throttled = await authorize(harness, query(), browser);
    expect(throttled.headers.get('retry-after')).toBe('2');
    expect(throttled.text).toContain('temporarily_unavailable');
    const anonymous = await authorize(harness, query());
    expect(anonymous.status).toBe(302);
  });
});

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
    expect(form.html).toContain(
      '<code>vault:reveal</code> <strong class="risk">Sensitive</strong>',
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
    expect(page.text).toContain('<p class="warning"><strong>Warning:</strong>');
    expect(page.text).toContain('loopback address (<code>127.0.0.1:61234</code>)');
    expect(page.text).toContain('<dt>Will redirect to</dt><dd><code>127.0.0.1:61234</code></dd>');
    expect(page.text).toContain('pre-registered by the operator');
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
