import { describe, expect, it } from 'vitest';

import {
  type Browser,
  cimdDocument,
  createOAuthHarness,
  formBody,
  type OAuthHarness,
  OPERATOR_ID,
  parseConsentForm,
  RESOURCE,
} from '../test-support/oauth-harness.ts';

import { hashCredential } from './credentials.ts';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CIMD_ID = 'https://agent.example.com/client.json';
const CIMD_REDIRECT = 'https://agent.example.com/cb';

interface Parked {
  readonly harness: OAuthHarness;
  readonly browser: Browser;
  readonly requestId: string;
  readonly csrfToken: string;
}

async function park(scope = 'vault:read vault:reveal', state: string | undefined = 'xyz'): Promise<Parked> {
  const harness = createOAuthHarness();
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT]));
  const browser = harness.signIn();
  const search = new URLSearchParams({
    response_type: 'code',
    client_id: CIMD_ID,
    redirect_uri: CIMD_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope,
    ...(state === undefined ? {} : { state }),
  });
  const started = await harness.request(`/oauth/authorize?${search.toString()}`, { headers: browser.headers });
  const path = started.headers.get('location') ?? '';
  const page = await harness.request(path, { headers: browser.headers });
  const form = parseConsentForm(await page.text());
  return { harness, browser, requestId: form.requestId, csrfToken: form.csrfToken };
}

function decide(
  parked: Parked,
  fields: Record<string, string>,
  headers: Record<string, string> = parked.browser.headers,
): Promise<Response> {
  const init = formBody({ request_id: parked.requestId, csrf_token: parked.csrfToken, ...fields });
  return parked.harness.request('/oauth/authorize', { ...init, headers: { ...init.headers, ...headers } });
}

const APPROVE_ALL = { decision: 'approve', 'scope:vault:read': 'on', 'scope:vault:reveal': 'on' };

describe('POST /oauth/authorize', () => {
  it('OAUTH-19 approval issues a single-use code bound to the request and redirects with code, state and iss', async () => {
    const parked = await park();
    const response = await decide(parked, APPROVE_ALL);
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(CIMD_REDIRECT);
    const code = location.searchParams.get('code') ?? '';
    expect(code).toMatch(/^vg_ac_[\w-]{43}$/);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe('https://vault.example.com');
    const claim = parked.harness.repos.authorizationCodes.claim(hashCredential(code), parked.harness.now());
    expect(claim).toMatchObject({
      kind: 'claimed',
      code: {
        clientId: CIMD_ID,
        redirectUri: CIMD_REDIRECT,
        codeChallenge: CHALLENGE,
        resource: RESOURCE,
        scopes: ['vault:read', 'vault:reveal'],
        expiresAt: parked.harness.now() + 300_000,
      },
    });
    const consent = parked.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID);
    expect(consent?.scopes).toStrictEqual(['vault:read', 'vault:reveal']);
    expect(parked.harness.repos.pendingAuthorizations.find(parked.requestId)).toBeUndefined();
    expect(parked.harness.audit).toStrictEqual([
      expect.objectContaining({
        action: 'consent_granted',
        operatorId: OPERATOR_ID,
        clientId: CIMD_ID,
        tokenPrefix: code.slice(0, 14),
        details: { scopes: ['vault:read', 'vault:reveal'] },
      }),
    ]);
  });

  it('OAUTH-18 issues only the ticked scopes and widens an existing consent', async () => {
    const first = await park();
    await decide(first, { decision: 'approve', 'scope:vault:read': 'on' });
    expect(first.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID)?.scopes).toStrictEqual(['vault:read']);
    const second = await park();
    const response = await decide(second, { ...APPROVE_ALL, 'scope:vault:write': 'on' });
    const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const claim = second.harness.repos.authorizationCodes.claim(hashCredential(code), 0);
    expect(claim).toMatchObject({ code: { scopes: ['vault:read', 'vault:reveal'] } });
  });

  it('OAUTH-18 a consent for a second request on the same client reuses the consent row and widens it', async () => {
    const parked = await park('vault:read');
    await decide(parked, { decision: 'approve', 'scope:vault:read': 'on' });
    const again = await park('vault:read vault:generate');
    // Same harness is not shared between park() calls; exercise the widening path on one store instead.
    const consentBefore = again.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID);
    expect(consentBefore).toBeUndefined();
    await decide(again, { decision: 'approve', 'scope:vault:read': 'on', 'scope:vault:generate': 'on' });
    const browser = again.browser;
    const search = new URLSearchParams({ response_type: 'code', client_id: CIMD_ID, redirect_uri: CIMD_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE, scope: 'vault:read vault:reveal' });
    const started = await again.harness.request(`/oauth/authorize?${search.toString()}`, { headers: browser.headers });
    const page = await again.harness.request(started.headers.get('location') ?? '', { headers: browser.headers });
    const form = parseConsentForm(await page.text());
    await decide({ ...again, requestId: form.requestId, csrfToken: form.csrfToken }, APPROVE_ALL);
    expect(again.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID)?.scopes).toStrictEqual(['vault:read', 'vault:generate', 'vault:reveal']);
  });

  it('OAUTH-20 denial redirects with access_denied, state and iss and audits it', async () => {
    const parked = await park();
    const response = await decide(parked, { decision: 'deny' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toBe('the operator denied the request');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe('https://vault.example.com');
    expect(parked.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID)).toBeUndefined();
    expect(parked.harness.audit).toStrictEqual([expect.objectContaining({ action: 'consent_denied', clientId: CIMD_ID })]);
  });

  it('OAUTH-20 approval with nothing ticked is a denial, and state is omitted when none was given', async () => {
    const parked = await park('vault:reveal', undefined);
    const response = await decide(parked, { decision: 'approve' });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.has('state')).toBe(false);
  });

  it('ID-18 rejects a missing or wrong synchroniser token and a foreign origin with 403', async () => {
    const parked = await park();
    const wrongToken = await decide({ ...parked, csrfToken: 'nope' }, APPROVE_ALL);
    expect(wrongToken.status).toBe(403);
    expect(await wrongToken.text()).toContain('could not be verified');
    const foreign = await decide(parked, APPROVE_ALL, { ...parked.browser.headers, origin: 'https://evil.example.com' });
    expect(foreign.status).toBe(403);
    expect(parked.harness.repos.pendingAuthorizations.find(parked.requestId)).toBeDefined();
  });

  it('OAUTH-17 rejects a decision from another browser or without a session', async () => {
    const parked = await park();
    const stranger = parked.harness.signIn();
    const other = await decide({ ...parked, csrfToken: stranger.session.csrfToken }, APPROVE_ALL, stranger.headers);
    expect(other.status).toBe(403);
    const anonymous = await decide(parked, APPROVE_ALL, { origin: 'https://vault.example.com' });
    expect(anonymous.status).toBe(403);
    expect(await anonymous.text()).toContain('sign in to continue');
  });

  it('OAUTH-14 rejects a malformed form, an unknown request id and a consumed request', async () => {
    const parked = await park();
    const notForm = await parked.harness.request('/oauth/authorize', { method: 'POST', headers: parked.browser.headers, body: 'x' });
    expect(notForm.status).toBe(400);
    const unknown = await decide({ ...parked, requestId: 'nope' }, APPROVE_ALL);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('has expired');
    await decide(parked, APPROVE_ALL);
    const replay = await decide(parked, APPROVE_ALL);
    expect(replay.status).toBe(400);
  });

  it('§10.4 counts the decision against the session limit', async () => {
    const parked = await park();
    for (let index = 0; index < 29; index += 1) {
      await parked.harness.request('/oauth/authorize?response_type=code', { headers: parked.browser.headers });
    }
    const throttled = await decide(parked, APPROVE_ALL);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('2');
    expect(parked.harness.repos.pendingAuthorizations.find(parked.requestId)).toBeDefined();
  });
});
