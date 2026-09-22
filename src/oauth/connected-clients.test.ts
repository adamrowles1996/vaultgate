import { describe, expect, it } from 'vitest';

import {
  csrfOf,
  pageText,
  PASSWORD,
  setUpOperator,
  signIn,
  totpFor,
} from '../test-support/identity-app.ts';
import {
  createOAuthHarness,
  type OAuthHarness,
  OPERATOR_ID,
  RESOURCE,
} from '../test-support/oauth-harness.ts';
import { formBody } from '../test-support/oauth-http.ts';

import { renderConnectedClients } from './connected-clients.ts';
import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';

import type { ConnectedClient } from './repositories/consents.ts';

const CLIENT_ID = 'vg_c_account-client';
const REVOKE_PATH = '/oauth/consents/consent-1/revoke';
const CONFIRMED = { csrfToken: 'csrf', isReauthenticated: true };
const UNCONFIRMED = { csrfToken: 'csrf', isReauthenticated: false };
const REAUTHENTICATION_LINK = '<a href="/account#sensitive-actions">confirm your password</a>';
const DISCONNECT_BUTTON = '<button type="submit">Disconnect</button>';

const UNNAMED: ConnectedClient = {
  id: 'consent-9',
  operatorId: OPERATOR_ID,
  clientId: 'vg_c_unnamed',
  scopes: ['vault:read'],
  grantedAt: 0,
  revokedAt: undefined,
  clientName: undefined,
  lastUsedAt: undefined,
};

function connect(harness: OAuthHarness, operatorId: string): string {
  harness.ensureOperator(operatorId);
  harness.repos.clients.upsert({
    id: 'client-row',
    clientId: CLIENT_ID,
    mode: 'dcr',
    clientName: 'Desk Agent',
    redirectUris: ['https://a.example/cb'],
    metadata: {},
    createdAt: 0,
    revokedAt: undefined,
  });
  harness.repos.consents.insert({
    id: 'consent-1',
    operatorId,
    clientId: CLIENT_ID,
    scopes: ['vault:read', 'vault:reveal'],
    grantedAt: harness.now(),
    revokedAt: undefined,
  });
  const access = mintCredential(CREDENTIAL_PREFIX.accessToken, (bytes) => Buffer.alloc(bytes, 4));
  harness.repos.tokens.insert({
    id: 'token-1',
    tokenHash: hashCredential(access),
    kind: 'access',
    familyId: 'fam',
    parentId: undefined,
    replacedById: undefined,
    clientId: CLIENT_ID,
    consentId: 'consent-1',
    scopes: ['vault:read'],
    resource: RESOURCE,
    issuedAt: 0,
    expiresAt: 9e12,
    revokedAt: undefined,
    lastUsedAt: harness.now() - 60_000,
  });
  return access;
}

function deniedReasons(harness: OAuthHarness): unknown[] {
  return harness.identity.audits
    .filter((event) => event.action === 'request.denied')
    .map((event) => event.details?.['reason']);
}

describe('renderConnectedClients', () => {
  it('OAUTH-30 says so when nothing is connected, whatever the re-authentication state', () => {
    for (const view of [CONFIRMED, UNCONFIRMED]) {
      const markup = renderConnectedClients([], view).markup;
      expect(markup).toContain('No clients are connected.');
      expect(markup).not.toContain('confirm your password');
    }
  });

  it('OAUTH-30 falls back to the client id for an unnamed client that was never used', () => {
    const markup = renderConnectedClients([UNNAMED], CONFIRMED).markup;
    expect(markup).toContain('<td>vg_c_unnamed</td>');
    expect(markup).toContain('<td>never</td>');
    expect(markup).toContain(DISCONNECT_BUTTON);
    expect(markup).not.toContain(REAUTHENTICATION_LINK);
  });

  it('ID-15 lists the clients without Disconnect forms and links to the re-authentication form until the password is confirmed', () => {
    const markup = renderConnectedClients([UNNAMED], UNCONFIRMED).markup;
    expect(markup).toContain('<td>vg_c_unnamed</td>');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('Disconnect');
    expect(markup).toContain(REAUTHENTICATION_LINK);
  });
});

describe('the account page', () => {
  it('OAUTH-30 ID-15 lists connected clients with their last-used time and, once re-authenticated, a revoke form', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn(OPERATOR_ID, { reauthenticated: true });
    connect(harness, OPERATOR_ID);
    const page = await harness.exchange('/account', { headers: signedIn.headers });
    expect(page.status).toBe(200);
    expect(page.text).toContain('<h3>Connected clients</h3>');
    expect(page.text).toContain('<td>Desk Agent</td>');
    expect(page.text).toContain('<td>vault:read vault:reveal</td>');
    expect(page.text).toContain(`<td>${new Date(harness.now() - 60_000).toISOString()}</td>`);
    expect(page.text).toContain(`<form method="post" action="${REVOKE_PATH}">`);
    expect(page.text).toContain(
      `<input type="hidden" name="csrf" value="${signedIn.session.csrfToken}" />`,
    );
    expect(page.text).not.toContain(REAUTHENTICATION_LINK);
  });

  it('ID-15 shows the clients without Disconnect forms and points at the re-authentication form until then', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn();
    connect(harness, OPERATOR_ID);
    const page = await harness.exchange('/account', { headers: signedIn.headers });
    expect(page.status).toBe(200);
    expect(page.text).toContain('<td>Desk Agent</td>');
    expect(page.text).not.toContain('Disconnect');
    expect(page.text).toContain(REAUTHENTICATION_LINK);
    expect(page.text).toContain('<section id="sensitive-actions">');
    expect(page.text).toContain('action="/account/reauthenticate"');
  });

  it('OAUTH-30 the revoke form ends the consent and every token, then returns to the account page', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn(OPERATOR_ID, { reauthenticated: true });
    const access = connect(harness, OPERATOR_ID);
    const response = await harness.exchange(
      REVOKE_PATH,
      formBody({ csrf: signedIn.session.csrfToken }, signedIn.headers),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account');
    expect(harness.repos.consents.findById('consent-1')?.revokedAt).toBe(harness.now());
    const verified = await harness.server.tokenVerifier.verify(access);
    expect(verified.ok).toBe(false);
    const page = await harness.exchange('/account', { headers: signedIn.headers });
    expect(page.text).toContain('No clients are connected.');
  });

  it('ID-15 refuses the revoke form outside the re-authentication window with 403 and a denied audit event', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn();
    const access = connect(harness, OPERATOR_ID);
    const response = await harness.exchange(
      REVOKE_PATH,
      formBody({ csrf: signedIn.session.csrfToken }, signedIn.headers),
    );
    expect(response.status).toBe(403);
    expect(response.text).toBe('Forbidden');
    expect(harness.identity.audits.at(-1)).toMatchObject({
      category: 'identity',
      action: 'request.denied',
      outcome: 'denied',
      details: { reason: 're-authentication required', path: REVOKE_PATH },
    });
    expect(harness.repos.consents.findById('consent-1')?.revokedAt).toBeUndefined();
    const verified = await harness.server.tokenVerifier.verify(access);
    expect(verified.ok).toBe(true);
  });

  it('ID-18 refuses the revoke form without a session, with a bad token, or for another operator', async () => {
    const harness = createOAuthHarness();
    const owner = harness.signIn(OPERATOR_ID, { reauthenticated: true });
    connect(harness, OPERATOR_ID);
    const anonymous = await harness.exchange(
      REVOKE_PATH,
      formBody({ csrf: owner.session.csrfToken }, { origin: 'https://vault.example.com' }),
    );
    expect(anonymous.status).toBe(403);
    const badToken = await harness.exchange(
      REVOKE_PATH,
      formBody({ csrf: 'wrong' }, owner.headers),
    );
    expect(badToken.status).toBe(403);
    const other = harness.signIn('operator-2', { reauthenticated: true });
    const stranger = await harness.exchange(
      REVOKE_PATH,
      formBody({ csrf: other.session.csrfToken }, other.headers),
    );
    expect(stranger.status).toBe(403);
    const notForm = await harness.exchange(REVOKE_PATH, {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notForm.status).toBe(403);
    expect(harness.repos.consents.findById('consent-1')?.revokedAt).toBeUndefined();
    expect(deniedReasons(harness)).toStrictEqual([
      'no session',
      'missing or stale synchroniser token',
      'unknown consent',
      'missing or stale synchroniser token',
    ]);
  });

  it('ID-15 OAUTH-30 setup, login, re-authentication and revocation through the real pages', async () => {
    const harness = createOAuthHarness();
    const setup = await setUpOperator(harness.identity);
    harness.advance(60_000);
    const loggedIn = await signIn(harness.identity, totpFor(setup.key, harness.now()));
    const browser = harness.browser();
    for (const [name, value] of loggedIn.cookies) {
      browser.cookies.set(name, value);
    }
    const operatorId = harness.identity.stores.operators.findAny()?.id ?? '';
    connect(harness, operatorId);
    const before = await pageText(browser, '/account');
    const csrf = csrfOf(before);
    const refused = await browser.submit(REVOKE_PATH, { csrf });
    const confirmed = await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    const during = await pageText(browser, '/account');
    const revoked = await browser.submit(REVOKE_PATH, { csrf });
    const after = await pageText(browser, '/account');
    expect(before).toContain('<td>Desk Agent</td>');
    expect(before).not.toContain('Disconnect');
    expect(before).toContain(REAUTHENTICATION_LINK);
    expect(refused.status).toBe(403);
    expect(confirmed.status).toBe(303);
    expect(during).toContain(DISCONNECT_BUTTON);
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe('/account');
    expect(after).toContain('No clients are connected.');
    expect(harness.audit.at(-1)).toMatchObject({ action: 'consent_revoked', operatorId });
    expect(deniedReasons(harness)).toStrictEqual(['re-authentication required']);
  });
});
