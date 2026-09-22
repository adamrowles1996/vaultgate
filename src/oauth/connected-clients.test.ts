import { describe, expect, it } from 'vitest';

import { setUpOperator } from '../test-support/identity-app.ts';
import { createOAuthHarness, OPERATOR_ID, RESOURCE } from '../test-support/oauth-harness.ts';
import { formBody } from '../test-support/oauth-http.ts';

import { renderConnectedClients } from './connected-clients.ts';
import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';

const CLIENT_ID = 'vg_c_account-client';

function connect(harness: ReturnType<typeof createOAuthHarness>, operatorId: string): string {
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

describe('renderConnectedClients', () => {
  it('OAUTH-30 says so when nothing is connected', () => {
    expect(renderConnectedClients([], 'csrf').markup).toContain('No clients are connected.');
  });

  it('OAUTH-30 falls back to the client id for an unnamed client that was never used', () => {
    const markup = renderConnectedClients(
      [
        {
          id: 'consent-9',
          operatorId: OPERATOR_ID,
          clientId: 'vg_c_unnamed',
          scopes: ['vault:read'],
          grantedAt: 0,
          revokedAt: undefined,
          clientName: undefined,
          lastUsedAt: undefined,
        },
      ],
      'csrf',
    ).markup;
    expect(markup).toContain('<td>vg_c_unnamed</td>');
    expect(markup).toContain('<td>never</td>');
  });
});

describe('the account page', () => {
  it('OAUTH-30 lists connected clients with their last-used time and a revoke form', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn();
    connect(harness, OPERATOR_ID);
    const page = await harness.exchange('/account', { headers: signedIn.headers });
    expect(page.status).toBe(200);
    expect(page.text).toContain('<h3>Connected clients</h3>');
    expect(page.text).toContain('<td>Desk Agent</td>');
    expect(page.text).toContain('<td>vault:read vault:reveal</td>');
    expect(page.text).toContain(`<td>${new Date(harness.now() - 60_000).toISOString()}</td>`);
    expect(page.text).toContain('<form method="post" action="/oauth/consents/consent-1/revoke">');
    expect(page.text).toContain(
      `<input type="hidden" name="csrf" value="${signedIn.session.csrfToken}" />`,
    );
  });

  it('OAUTH-30 the revoke form ends the consent and every token, then returns to the account page', async () => {
    const harness = createOAuthHarness();
    const signedIn = harness.signIn();
    const access = connect(harness, OPERATOR_ID);
    const response = await harness.exchange(
      '/oauth/consents/consent-1/revoke',
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

  it('ID-18 refuses the revoke form without a session, with a bad token, or for another operator', async () => {
    const harness = createOAuthHarness();
    const owner = harness.signIn();
    connect(harness, OPERATOR_ID);
    const anonymous = await harness.exchange(
      '/oauth/consents/consent-1/revoke',
      formBody({ csrf: owner.session.csrfToken }, { origin: 'https://vault.example.com' }),
    );
    expect(anonymous.status).toBe(403);
    const badToken = await harness.exchange(
      '/oauth/consents/consent-1/revoke',
      formBody({ csrf: 'wrong' }, owner.headers),
    );
    expect(badToken.status).toBe(403);
    const other = harness.signIn('operator-2');
    const stranger = await harness.exchange(
      '/oauth/consents/consent-1/revoke',
      formBody({ csrf: other.session.csrfToken }, other.headers),
    );
    expect(stranger.status).toBe(403);
    const notForm = await harness.exchange('/oauth/consents/consent-1/revoke', {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notForm.status).toBe(403);
    expect(harness.repos.consents.findById('consent-1')?.revokedAt).toBeUndefined();
  });

  it('shows the section to an operator who set up through the real pages', async () => {
    const harness = createOAuthHarness();
    const setup = await setUpOperator(harness.identity);
    const browser = harness.browser();
    for (const [name, value] of setup.browser.cookies) {
      browser.cookies.set(name, value);
    }
    const page = await browser.get('/account');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('No clients are connected.');
  });
});
