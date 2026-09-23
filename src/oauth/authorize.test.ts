import { describe, expect, it } from 'vitest';

import {
  authorize,
  CHALLENGE,
  CIMD_ID,
  CIMD_REDIRECT,
  CONSENT_PATH,
  DESK,
  firstCookie,
  harnessWithClients,
  LOOPBACK_REDIRECT,
  parkedPath,
  query,
  requestIdOf,
} from '../test-support/authorize-fixtures.ts';
import { createOAuthHarness, RESOURCE } from '../test-support/oauth-harness.ts';
import { cimdDocument } from '../test-support/oauth-http.ts';

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
    expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.text).toContain(text);
  });

  it('OAUTH-14 renders an error page for a repeated parameter', async () => {
    const harness = harnessWithClients();
    const response = await authorize(harness, `${query()}&state=again`, harness.signIn());
    expect(response.status).toBe(400);
    expect(response.text).toContain('parameter &quot;state&quot; is repeated');
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

  it('§10.4 limits an anonymous browser by address: rotating the binding cookie buys nothing', async () => {
    const harness = harnessWithClients();
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const cookie = `__Host-vg_authz=rotated-${index}`;
      const response = await harness.exchange(query(), { headers: { cookie } });
      statuses.push(response.status);
    }
    expect(statuses).toStrictEqual([...Array.from({ length: 30 }, () => 302), 429]);
    const bare = await authorize(harness, query());
    expect(bare.status).toBe(429);
    const signedIn = await authorize(harness, query(), harness.signIn());
    expect(signedIn.status).toBe(302);
  });
});
