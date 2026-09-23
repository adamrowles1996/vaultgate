import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_VAULT } from '../test-support/fake-vault-connection.ts';
import {
  createHarness,
  csrfOf,
  type Harness,
  pageText,
  PASSWORD,
  setUpOperator,
} from '../test-support/identity-app.ts';

import type { Browser } from '../test-support/browser.ts';

const SECRETS = {
  client_secret: 'CANARY-FORM-CLIENT-SECRET',
  master_password: 'CANARY-FORM-MASTER-PASSWORD',
};
const FIVE_MINUTES = 5 * 60_000;

async function confirmedBrowser(harness: Harness): Promise<{ browser: Browser; csrf: string }> {
  const { browser } = await setUpOperator(harness);
  const csrf = csrfOf(await pageText(browser, '/account'));
  await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
  return { browser, csrf };
}

function everythingObservable(harness: Harness, markup: string): string {
  return [markup, JSON.stringify(harness.audits), JSON.stringify(harness.logged())].join('\n');
}

function vaultAudits(harness: Harness) {
  return harness.audits.filter((event) => event.action === 'vault.settings_updated');
}

describe('GET /account vault connection', () => {
  it('ID-25 shows the unconfigured status and asks for the password before the form', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const markup = await pageText(browser, '/account');
    expect(markup).toContain('<section id="vault">');
    expect(markup).toContain('data-label="Value">not configured</td>');
    expect(markup).toContain('>none since start-up<');
    expect(markup).toContain('>unknown until the vault is ready<');
    expect(markup).toContain('Confirm your password above to change the vault connection.');
    expect(markup).not.toContain('action="/account/vault"');
  });

  it('ID-25 shows a seeded, ready connection with its server, account and last sync', async () => {
    const harness = createHarness();
    harness.vault.current = ENVIRONMENT_VAULT;
    const { browser } = await setUpOperator(harness);
    const markup = await pageText(browser, '/account');
    expect(markup).toContain('seeded from the environment; saving here takes over');
    expect(markup).toContain('>https://vault.example.test<');
    expect(markup).toContain('>a***@example.com<');
    expect(markup).toContain('data-label="Value">yes</td>');
    expect(markup).toContain('>2026-09-22T11:00:00.000Z<');
  });

  it('ID-15 ID-25 offers the form after re-authentication, with every secret field empty', async () => {
    const harness = createHarness();
    const { browser } = await confirmedBrowser(harness);
    const markup = await pageText(browser, '/account');
    expect(markup).toContain('action="/account/vault"');
    expect(markup).toContain('placeholder="https://vault.bitwarden.com"');
    expect(markup).toContain('<code>bitwarden.eu</code>');
    expect(markup).toMatch(/<input name="client_secret" type="password" autocomplete="off" \/>/);
    expect(markup).toMatch(/<input name="master_password" type="password" autocomplete="off" \/>/);
    expect(markup).not.toContain('Leave a secret blank');
    harness.vault.current = ENVIRONMENT_VAULT;
    expect(await pageText(browser, '/account')).toContain(
      'Leave a secret blank to keep the one in use.',
    );
  });
});

describe('POST /account/vault', () => {
  it('ID-25 saves, switches and comes back to the new status; no secret is ever observable', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmedBrowser(harness);
    const response = await browser.submit('/account/vault', {
      csrf,
      server_url: ' bitwarden.eu ',
      client_id: ' user.next ',
      client_secret: `${SECRETS.client_secret} `,
      master_password: SECRETS.master_password,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account?notice=vault-updated#vault');
    expect(harness.vault.calls).toStrictEqual([
      {
        input: {
          serverUrl: 'bitwarden.eu',
          clientId: 'user.next',
          clientSecret: SECRETS.client_secret,
          masterPassword: SECRETS.master_password,
        },
        operatorId: harness.stores.operators.findAny()?.id,
      },
    ]);
    const markup = await pageText(browser, '/account?notice=vault-updated');
    expect(markup).toContain('Vault connection saved. The backend is using it now.');
    expect(markup).toContain('>configured on this page<');
    expect(markup).toContain('>bitwarden.eu<');
    expect(vaultAudits(harness)).toStrictEqual([
      expect.objectContaining({
        category: 'identity',
        outcome: 'ok',
        operatorId: harness.stores.operators.findAny()?.id,
        ip: '203.0.113.7',
        details: { server: 'bitwarden.eu' },
      }),
    ]);
    const observable = everythingObservable(harness, markup);
    expect(observable).not.toContain(SECRETS.client_secret);
    expect(observable).not.toContain(SECRETS.master_password);
  });

  it('ID-25 lets blank secrets stand for the ones in use once a connection exists', async () => {
    const harness = createHarness();
    harness.vault.current = ENVIRONMENT_VAULT;
    const { browser, csrf } = await confirmedBrowser(harness);
    const response = await browser.submit('/account/vault', {
      csrf,
      server_url: '',
      client_id: 'user.same',
      client_secret: '',
      master_password: '',
    });
    expect(response.status).toBe(303);
    expect(harness.vault.calls[0]?.input).toStrictEqual({
      serverUrl: undefined,
      clientId: 'user.same',
      clientSecret: undefined,
      masterPassword: undefined,
    });
    expect(vaultAudits(harness)[0]?.details).toStrictEqual({ server: 'bitwarden.com' });
  });

  it('ID-25 rejects bad input with the reason and re-shows only the non-secret fields', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmedBrowser(harness);
    const cases: [Record<string, string>, string][] = [
      [
        { server_url: 'http://plain.example', client_id: 'user.x', ...SECRETS },
        'the server must be bitwarden.eu or an https:// URL',
      ],
      [{ client_id: '  ', ...SECRETS }, 'enter the API key client id'],
      [
        { client_id: 'user.x', master_password: 'only one' },
        'enter both the API key client secret and the master password',
      ],
      [
        { client_id: 'user.x', ...SECRETS, master_password: 'x'.repeat(1025) },
        'a secret is longer than the vault accepts',
      ],
    ];
    for (const [fields, message] of cases) {
      const response = await browser.submit('/account/vault', { csrf, ...fields });
      const markup = await response.text();
      expect(response.status).toBe(400);
      expect(markup).toContain(`<p class="error" role="alert">${message}</p>`);
      expect(markup).toContain('action="/account/vault"');
      expect(markup).not.toContain(SECRETS.client_secret);
      expect(markup).not.toContain(SECRETS.master_password);
    }
    const last = await browser.submit('/account/vault', {
      csrf,
      client_id: 'user.kept',
      server_url: 'nope',
    });
    const lastMarkup = await last.text();
    expect(lastMarkup).toContain('value="user.kept"');
    expect(lastMarkup).toContain('value="nope"');
    expect(harness.vault.calls).toStrictEqual([]);
    expect(vaultAudits(harness)).toStrictEqual([]);
  });

  it('ID-25 re-renders the form with the backend reason when the switch fails, secret-free', async () => {
    const harness = createHarness();
    harness.vault.failWith = 'the vault rejected the master password';
    const { browser, csrf } = await confirmedBrowser(harness);
    const response = await browser.submit('/account/vault', {
      csrf,
      server_url: 'https://vault.example.test',
      client_id: 'user.next',
      ...SECRETS,
    });
    const markup = await response.text();
    expect(response.status).toBe(503);
    expect(markup).toContain(
      '<p class="error" role="alert">the vault rejected the master password</p>',
    );
    expect(markup).toContain('action="/account/vault"');
    expect(markup).toContain('value="user.next"');
    expect(markup).toContain('value="https://vault.example.test"');
    expect(markup).toContain('data-label="Value">not configured</td>');
    expect(vaultAudits(harness)).toStrictEqual([
      expect.objectContaining({
        outcome: 'failure',
        details: {
          server: 'https://vault.example.test',
          reason: 'the vault rejected the master password',
        },
      }),
    ]);
    const observable = everythingObservable(harness, markup);
    expect(observable).not.toContain(SECRETS.client_secret);
    expect(observable).not.toContain(SECRETS.master_password);
  });

  it('ID-15 refuses the change without a re-authentication in the last five minutes', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const csrf = csrfOf(await pageText(browser, '/account'));
    const fields = { csrf, client_id: 'user.next', ...SECRETS };
    const denied = await browser.submit('/account/vault', fields);
    expect(denied.status).toBe(403);
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    harness.advance(FIVE_MINUTES + 1);
    const stale = await browser.submit('/account/vault', fields);
    expect(stale.status).toBe(403);
    expect(harness.vault.calls).toStrictEqual([]);
    expect(harness.audits.filter((event) => event.action === 'request.denied')).toStrictEqual([
      expect.objectContaining({
        details: { reason: 're-authentication required', path: '/account/vault' },
      }),
      expect.objectContaining({
        details: { reason: 're-authentication required', path: '/account/vault' },
      }),
    ]);
  });

  it('ID-18 refuses a cross-site submission', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmedBrowser(harness);
    const fields = { csrf, client_id: 'user.next', ...SECRETS };
    const crossSite = await browser.submit('/account/vault', fields, { origin: false });
    expect(crossSite.status).toBe(403);
    const staleToken = await browser.submit('/account/vault', { ...fields, csrf: 'stale' });
    expect(staleToken.status).toBe(403);
    expect(harness.vault.calls).toStrictEqual([]);
  });
});

describe('POST /setup and the vault', () => {
  it('ID-3 ID-25 ends the first run with the way to connect the vault when none is configured', async () => {
    const unconfigured = await setUpOperator(createHarness());
    expect(unconfigured.page).toContain('<a href="/account#vault">Connect the vault</a>');
    const harness = createHarness();
    harness.vault.current = ENVIRONMENT_VAULT;
    const configured = await setUpOperator(harness);
    expect(configured.page).not.toContain('Connect the vault');
    expect(configured.page).toContain('Continue to your account');
  });
});
