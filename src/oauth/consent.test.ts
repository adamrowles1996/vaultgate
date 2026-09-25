import { describe, expect, it } from 'vitest';

import {
  createOAuthHarness,
  type Exchange,
  type OAuthHarness,
  OPERATOR_ID,
  RESOURCE,
  type SignedIn,
} from '../test-support/oauth-harness.ts';
import { cimdDocument, formBody, openConsent } from '../test-support/oauth-http.ts';

import { hashCredential } from './credentials.ts';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CIMD_ID = 'https://agent.example.com/client.json';
const CIMD_REDIRECT = 'https://agent.example.com/cb';
const ISSUER = 'https://vault.example.com';

interface Parked {
  readonly harness: OAuthHarness;
  readonly browser: SignedIn;
  readonly requestId: string;
  readonly csrfToken: string;
}

function authorizeParameters(scope: string, state: string | null): Record<string, string> {
  return {
    response_type: 'code',
    client_id: CIMD_ID,
    redirect_uri: CIMD_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope,
    ...(state !== null && { state }),
  };
}

async function parkOn(
  harness: OAuthHarness,
  browser: SignedIn,
  scope: string,
  state: string | null = 'xyz',
): Promise<Parked> {
  const form = await openConsent(harness, browser, authorizeParameters(scope, state));
  return { harness, browser, requestId: form.requestId, csrfToken: form.csrfToken };
}

async function park(
  scope = 'vault:read vault:reveal',
  state: string | null = 'xyz',
): Promise<Parked> {
  const harness = createOAuthHarness();
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT]));
  return parkOn(harness, harness.signIn(), scope, state);
}

function decide(
  parked: Parked,
  fields: Record<string, string>,
  headers: Readonly<Record<string, string>> = parked.browser.headers,
): Promise<Exchange> {
  return parked.harness.exchange(
    '/oauth/authorize',
    formBody({ request_id: parked.requestId, csrf: parked.csrfToken, ...fields }, headers),
  );
}

function redirectOf(response: Exchange): URL {
  return new URL(response.headers.get('location') ?? '');
}

function codeOf(response: Exchange): string {
  return redirectOf(response).searchParams.get('code') ?? '';
}

const APPROVE_ALL = { decision: 'approve', 'scope:vault:read': 'on', 'scope:vault:reveal': 'on' };

describe('POST /oauth/authorize', () => {
  it('OAUTH-19 approval issues a single-use code bound to the request and redirects with code, state and iss', async () => {
    const parked = await park();
    const response = await decide(parked, APPROVE_ALL);
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const location = redirectOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(CIMD_REDIRECT);
    const code = codeOf(response);
    expect(code).toMatch(/^vg_ac_[\w-]{43}$/);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    const { harness } = parked;
    const claim = harness.repos.authorizationCodes.claim(hashCredential(code), harness.now());
    expect(claim).toMatchObject({
      kind: 'claimed',
      code: {
        clientId: CIMD_ID,
        redirectUri: CIMD_REDIRECT,
        codeChallenge: CHALLENGE,
        resource: RESOURCE,
        scopes: ['vault:read', 'vault:reveal'],
        expiresAt: harness.now() + 300_000,
      },
    });
    const consent = harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID);
    expect(consent?.scopes).toStrictEqual(['vault:read', 'vault:reveal']);
    expect(harness.repos.pendingAuthorizations.find(parked.requestId)).toBeUndefined();
    expect(harness.audit).toHaveLength(1);
    expect(harness.audit[0]).toMatchObject({
      action: 'consent_granted',
      operatorId: OPERATOR_ID,
      clientId: CIMD_ID,
      tokenPrefix: code.slice(0, 14),
      details: { scopes: ['vault:read', 'vault:reveal'] },
    });
  });

  it('OAUTH-18 issues only the ticked scopes, ignoring a scope the deployment does not enable', async () => {
    const parked = await park();
    const response = await decide(parked, {
      ...APPROVE_ALL,
      'scope:vault:write': 'on',
      'scope:vault:reveal': '',
    });
    const claim = parked.harness.repos.authorizationCodes.claim(
      hashCredential(codeOf(response)),
      0,
    );
    expect(claim).toMatchObject({ code: { scopes: ['vault:read'] } });
    expect(parked.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID)?.scopes).toStrictEqual([
      'vault:read',
    ]);
  });

  it('OAUTH-18 grants an enabled scope the operator ticks although the client did not request it', async () => {
    const parked = await park('vault:read');
    const response = await decide(parked, {
      decision: 'approve',
      'scope:vault:read': 'on',
      'scope:vault:generate': 'on',
    });
    const claim = parked.harness.repos.authorizationCodes.claim(
      hashCredential(codeOf(response)),
      0,
    );
    expect(claim).toMatchObject({ code: { scopes: ['vault:read', 'vault:generate'] } });
    expect(parked.harness.audit[0]).toMatchObject({
      action: 'consent_granted',
      details: { scopes: ['vault:read', 'vault:generate'] },
    });
  });

  it('OAUTH-18 a later approval for the same client widens the existing consent row', async () => {
    const first = await park('vault:read vault:generate');
    await decide(first, {
      decision: 'approve',
      'scope:vault:read': 'on',
      'scope:vault:generate': 'on',
    });
    const before = first.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID);
    const second = await parkOn(first.harness, first.browser, 'vault:read vault:reveal');
    await decide(second, APPROVE_ALL);
    const after = first.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID);
    expect(after?.id).toBe(before?.id);
    expect(after?.scopes).toStrictEqual(['vault:read', 'vault:generate', 'vault:reveal']);
  });

  it('OAUTH-20 denial redirects with access_denied, state and iss and audits it', async () => {
    const parked = await park();
    const response = await decide(parked, { decision: 'deny' });
    expect(response.status).toBe(302);
    const location = redirectOf(response);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toBe('the operator denied the request');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(parked.harness.repos.consents.findActive(OPERATOR_ID, CIMD_ID)).toBeUndefined();
    expect(parked.harness.audit).toHaveLength(1);
    expect(parked.harness.audit[0]).toMatchObject({ action: 'consent_denied', clientId: CIMD_ID });
  });

  it('OAUTH-20 approval with nothing ticked is a denial, and state is omitted when none was given', async () => {
    const parked = await park('vault:reveal', null);
    const response = await decide(parked, { decision: 'approve' });
    const location = redirectOf(response);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.has('state')).toBe(false);
  });

  it('ID-18 rejects a missing or wrong synchroniser token and a foreign origin with 403', async () => {
    const parked = await park();
    const wrongToken = await decide({ ...parked, csrfToken: 'nope' }, APPROVE_ALL);
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.text).toBe('Forbidden');
    const foreign = await decide(parked, APPROVE_ALL, {
      ...parked.browser.headers,
      origin: 'https://evil.example.com',
    });
    expect(foreign.status).toBe(403);
    expect(parked.harness.repos.pendingAuthorizations.find(parked.requestId)).toBeDefined();
  });

  it('OAUTH-17 rejects a decision from another browser or without a session', async () => {
    const parked = await park();
    const stranger = parked.harness.signIn();
    const other = await decide(
      { ...parked, csrfToken: stranger.session.csrfToken },
      APPROVE_ALL,
      stranger.headers,
    );
    expect(other.status).toBe(403);
    expect(other.text).toContain('belongs to another browser');
    const anonymous = await decide(parked, APPROVE_ALL, { origin: ISSUER });
    expect(anonymous.status).toBe(403);
    expect(anonymous.text).toBe('Forbidden');
  });

  it('OAUTH-14 rejects a malformed form, an unknown request id and a consumed request', async () => {
    const parked = await park();
    const notForm = await parked.harness.exchange('/oauth/authorize', {
      method: 'POST',
      headers: parked.browser.headers,
      body: 'x',
    });
    expect(notForm.status).toBe(400);
    const unknown = await decide({ ...parked, requestId: 'nope' }, APPROVE_ALL);
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('has expired');
    await decide(parked, APPROVE_ALL);
    const replay = await decide(parked, APPROVE_ALL);
    expect(replay.status).toBe(400);
  });

  it('OAUTH-17 refuses a decision without a request id or for a pending row that does not read back', async () => {
    const parked = await park();
    const missing = await parked.harness.exchange(
      '/oauth/authorize',
      formBody({ csrf: parked.csrfToken, decision: 'approve' }, parked.browser.headers),
    );
    expect(missing.status).toBe(400);
    expect(missing.text).toContain('has expired');
    parked.harness.repos.pendingAuthorizations.insert({
      id: 'corrupt',
      sessionBindingHash: hashCredential(parked.browser.session.idHash),
      parameters: { client_id: 'only' },
      expiresAt: parked.harness.now() + 60_000,
    });
    const corrupt = await decide({ ...parked, requestId: 'corrupt' }, APPROVE_ALL);
    expect(corrupt.status).toBe(400);
    const page = await parked.harness.exchange('/oauth/authorize/corrupt', {
      headers: parked.browser.headers,
    });
    expect(page.status).toBe(400);
  });

  it('§10.4 counts the decision against the session limit', async () => {
    const parked = await park();
    for (let index = 0; index < 29; index += 1) {
      await parked.harness.request('/oauth/authorize?response_type=code', {
        headers: parked.browser.headers,
      });
    }
    const throttled = await decide(parked, APPROVE_ALL);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('2');
    expect(parked.harness.repos.pendingAuthorizations.find(parked.requestId)).toBeDefined();
  });
});
