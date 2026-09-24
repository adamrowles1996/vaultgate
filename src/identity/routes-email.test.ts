import { describe, expect, it } from 'vitest';

import {
  createHarness,
  csrfOf,
  EMAIL,
  type Harness,
  makeLegacy,
  pageText,
  PASSWORD,
  setUpOperator,
  signIn,
  statusOf,
  totpFor,
} from '../test-support/identity-app.ts';

import { LOGIN_FAILURE_MESSAGE } from './pages/login.ts';

import type { Browser } from '../test-support/browser.ts';

const MINUTE = 60_000;
const NEW_EMAIL = 'grace@example.com';

async function confirmedBrowser(harness: Harness): Promise<{ browser: Browser; key: string }> {
  const { browser, key } = await setUpOperator(harness);
  const csrf = csrfOf(await pageText(browser, '/account'));
  await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
  return { browser, key };
}

async function signInWith(harness: Harness, email: string, code: string): Promise<number> {
  const browser = harness.browser();
  const csrf = csrfOf(await pageText(browser, '/login'));
  await browser.submit('/login', { csrf, email, password: PASSWORD });
  await browser.submit('/login/verify', { csrf, code });
  return statusOf(browser, '/account');
}

describe('POST /account/email', () => {
  it('ID-15 needs a fresh re-authentication', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const csrf = csrfOf(await pageText(browser, '/account'));
    const response = await browser.submit('/account/email', { csrf, email: NEW_EMAIL });
    expect(response.status).toBe(403);
    expect(harness.audits.at(-1)?.details?.['reason']).toBe('re-authentication required');
    expect(harness.stores.operators.findAny()?.email).toBe(EMAIL);
  });

  it('ID-3 ID-15 validates, changes the address and makes it the one to sign in with', async () => {
    const harness = createHarness();
    const { browser, key } = await confirmedBrowser(harness);
    const page = await pageText(browser, '/account');
    const csrf = csrfOf(page);
    const bad = await browser.submit('/account/email', { csrf, email: 'grace' });
    const changed = await browser.submit('/account/email', {
      csrf,
      email: ` ${NEW_EMAIL.toUpperCase()} `,
    });
    const after = await pageText(browser, '/account?notice=email-changed');
    harness.advance(MINUTE);
    const oldStatus = await signInWith(harness, EMAIL, totpFor(key, harness.now()));
    harness.advance(MINUTE);
    const newStatus = await signInWith(harness, NEW_EMAIL, totpFor(key, harness.now()));
    expect(page).toContain(`it is <strong>${EMAIL}</strong> now`);
    expect(page).toContain('action="/account/email"');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('enter a valid e-mail address');
    expect(changed.status).toBe(303);
    expect(changed.headers.get('location')).toBe('/account?notice=email-changed');
    expect(after).toContain('E-mail address changed.');
    expect(after).toContain(`Signed in as <strong>${NEW_EMAIL}</strong>`);
    expect(harness.stores.operators.findAny()?.email).toBe(NEW_EMAIL);
    expect(harness.audits.filter((event) => event.action === 'email.changed')).toHaveLength(1);
    expect(harness.audits.find((event) => event.action === 'email.changed')?.details).toStrictEqual(
      { email: NEW_EMAIL },
    );
    expect([oldStatus, newStatus]).toStrictEqual([303, 200]);
  });
});

describe('legacy mode (account created before the operator-email migration)', () => {
  it('ID-26 signs in with the password alone and counts failures against the operator id', async () => {
    const harness = createHarness();
    const { key } = await setUpOperator(harness);
    makeLegacy(harness);
    harness.advance(MINUTE);
    const anonymous = harness.browser();
    const page = await pageText(anonymous, '/login');
    const csrf = csrfOf(page);
    const wrong = await anonymous.submit('/login', { csrf, email: EMAIL, password: 'not it' });
    const browser = await signIn(harness, totpFor(key, harness.now()));
    const account = await browser.get('/account');
    const wrongText = await wrong.text();
    expect(page).not.toContain('name="email"');
    expect(page).toContain('name="password"');
    expect(wrong.status).toBe(401);
    expect(wrongText).toContain(LOGIN_FAILURE_MESSAGE);
    expect(wrongText).not.toContain('name="email"');
    expect(account.status).toBe(200);
    expect(harness.audits.map((event) => [event.action, event.details])).toStrictEqual([
      ['operator.created', { email: EMAIL }],
      ['login.failed', { step: 'password' }],
      ['login.succeeded', { method: 'totp' }],
    ]);
    const operatorId = harness.stores.operators.findAny()?.id ?? '';
    expect(harness.stores.loginAttempts.countFailuresSince(`operator:${operatorId}`, 0)).toBe(1);
    expect(harness.stores.loginAttempts.countFailuresSince(`email:${EMAIL}`, 0)).toBe(0);
  });

  it('ID-26 replaces the account page with the set-your-e-mail page until an address is set', async () => {
    const harness = createHarness();
    const { browser, key } = await setUpOperator(harness);
    makeLegacy(harness);
    const before = await pageText(browser, '/account');
    const csrf = csrfOf(before);
    const passwordChange = await browser.submit('/account/password', {
      csrf,
      password: 'a brand new passphrase',
    });
    const earlyEmail = await browser.submit('/account/email', { csrf, email: NEW_EMAIL });
    const wrongPassword = await browser.submit('/account/reauthenticate', {
      csrf,
      password: 'not it',
    });
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    const confirmed = await pageText(browser, '/account?notice=reauthenticated');
    const bad = await browser.submit('/account/email', { csrf, email: 'grace' });
    const set = await browser.submit('/account/email', { csrf, email: NEW_EMAIL });
    const after = await pageText(browser, '/account?notice=email-set');
    harness.advance(MINUTE);
    const legacyLogin = harness.browser();
    const loginPage = await pageText(legacyLogin, '/login');
    const status = await signInWith(harness, NEW_EMAIL, totpFor(key, harness.now()));
    expect(before).toContain('Set your e-mail address');
    expect(before).toContain('action="/account/reauthenticate"');
    expect(before).not.toContain('action="/account/email"');
    expect(before).not.toContain('Connected clients');
    expect(before).toContain('action="/logout"');
    expect([passwordChange.status, earlyEmail.status, wrongPassword.status]).toStrictEqual([
      403, 403, 401,
    ]);
    const wrongPasswordText = await wrongPassword.text();
    expect(wrongPasswordText).toContain('Set your e-mail address');
    expect(wrongPasswordText).toContain('That password was not recognised.');
    expect(confirmed).toContain('Password confirmed.');
    expect(confirmed).toContain('action="/account/email"');
    expect(confirmed).not.toContain('action="/account/reauthenticate"');
    const badText = await bad.text();
    expect(bad.status).toBe(400);
    expect(badText).toContain('Set your e-mail address');
    expect(badText).toContain('enter a valid e-mail address');
    expect(set.status).toBe(303);
    expect(set.headers.get('location')).toBe('/account?notice=email-set');
    expect(after).toContain('E-mail address saved.');
    expect(after).toContain(`Signed in as <strong>${NEW_EMAIL}</strong>`);
    expect(after).toContain('<h2>Sessions</h2>');
    expect(loginPage).toContain('name="email"');
    expect(status).toBe(200);
    expect(
      harness.audits
        .filter((event) => event.action === 'request.denied')
        .map((event) => event.details),
    ).toStrictEqual([
      { reason: 'e-mail address required', path: '/account/password' },
      { reason: 're-authentication required', path: '/account/email' },
    ]);
  });

  it('ID-26 keeps the second step and its audit trail free of an address it does not have', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    makeLegacy(harness);
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    await browser.submit('/login', { csrf, password: PASSWORD });
    const refused = await browser.submit('/login/verify', { csrf, code: '000000' });
    expect(refused.status).toBe(401);
    expect(harness.audits.at(-1)?.details).toStrictEqual({ step: 'second-factor' });
  });
});
