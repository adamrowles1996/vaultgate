import { describe, expect, it } from 'vitest';

import {
  createHarness,
  csrfOf,
  enrolmentKeyOf,
  type Harness,
  pageText,
  PASSWORD,
  recoveryCodesOf,
  setUpOperator,
  signIn,
  statusOf,
  totpFor,
} from '../test-support/identity-app.ts';

import { hashRecoveryCode } from './recovery-codes.ts';

import type { Browser } from '../test-support/browser.ts';

/**
Simulates a store whose operator row is gone while a session row survives (no cascade).
*/
function removeOperatorKeepingSessions(harness: Harness): void {
  harness.database.exec('PRAGMA foreign_keys = OFF');
  harness.database.exec('DELETE FROM operators');
  harness.database.exec('PRAGMA foreign_keys = ON');
}

async function reauthenticate(browser: Browser, password = PASSWORD): Promise<Response> {
  const csrf = csrfOf(await pageText(browser, '/account'));
  return browser.submit('/account/reauthenticate', { csrf, password });
}

async function confirmedBrowser(
  harness: Harness,
): Promise<{ browser: Browser; csrf: string; key: string }> {
  const { browser, key } = await setUpOperator(harness);
  await reauthenticate(browser);
  const csrf = csrfOf(await pageText(browser, '/account'));
  return { browser, csrf, key };
}

describe('GET /account', () => {
  it('ID-21 sends an anonymous browser to login with a return path', async () => {
    const harness = createHarness();
    const response = await harness.browser().get('/account');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?next=%2Faccount');
  });

  it('ID-14 ID-15 lists sessions, marks the current one and offers re-authentication first', async () => {
    const harness = createHarness();
    const { browser, key } = await setUpOperator(harness);
    harness.advance(60_000);
    await signIn(harness, totpFor(key, harness.now()));
    harness.database.exec('UPDATE sessions SET ip = NULL');
    const response = await browser.get('/account?notice=unknown');
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(markup).toContain('Signed in as <strong>ada@example.com</strong>');
    expect(markup.match(/data-label="Started"/g)).toHaveLength(2);
    expect(markup.match(/\(this one\)/g)).toHaveLength(1);
    expect(markup).toContain('action="/account/reauthenticate"');
    expect(markup).not.toContain('action="/account/password"');
    expect(markup).not.toContain('class="notice"');
    expect(markup).toContain('Connected clients');
    expect(markup).toContain('<td data-label="Address">unknown</td>');
    for (const heading of ['Started', 'Last seen', 'Browser']) {
      expect(markup).toContain(`<th>${heading}</th>`);
      expect(markup.match(new RegExp(`<td data-label="${heading}">`, 'g'))).toHaveLength(2);
    }
    expect(markup).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    );
  });

  it('ID-21 redirects when the operator no longer exists', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    removeOperatorKeepingSessions(harness);
    const response = await browser.get('/account');
    expect(response.status).toBe(303);
  });
});

describe('POST /account/reauthenticate', () => {
  it('ID-15 opens the sensitive actions for five minutes after the password is confirmed', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const wrong = await reauthenticate(browser, 'not the password');
    const right = await reauthenticate(browser);
    const open = await pageText(browser, '/account?notice=reauthenticated');
    harness.advance(5 * 60_000);
    const closed = await pageText(browser, '/account');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('That password was not recognised.');
    expect(right.status).toBe(303);
    expect(right.headers.get('location')).toBe('/account?notice=reauthenticated');
    expect(open).toContain('Password confirmed.');
    expect(open).toContain('action="/account/password"');
    expect(closed).not.toContain('action="/account/password"');
    expect(harness.delays).toStrictEqual([0, 0]);
    expect(harness.audits.map((event) => event.action)).toStrictEqual([
      'operator.created',
      'reauthentication.failed',
      'reauthentication.succeeded',
    ]);
  });

  it('ID-18 refuses without a session, with a stale token or once the operator is gone', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const anonymous = await harness
      .browser()
      .submit('/account/reauthenticate', { password: PASSWORD });
    const stale = await browser.submit('/account/reauthenticate', {
      csrf: 'nope',
      password: PASSWORD,
    });
    const csrf = csrfOf(await pageText(browser, '/account'));
    removeOperatorKeepingSessions(harness);
    const gone = await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    expect([anonymous.status, stale.status, gone.status]).toStrictEqual([403, 403, 403]);
    expect(harness.audits.map((event) => event.details?.['reason'])).toStrictEqual([
      undefined,
      'no session',
      'missing or stale synchroniser token',
      'operator no longer exists',
    ]);
  });
});

describe('re-authentication gate', () => {
  it('ID-15 ID-18 refuses every sensitive action without a session', async () => {
    const harness = createHarness();
    const browser = harness.browser();
    const password = await browser.submit('/account/password', { password: PASSWORD });
    const totp = await browser.submit('/account/totp/rotate', {});
    const codes = await browser.submit('/account/recovery-codes', {});
    expect([password.status, totp.status, codes.status]).toStrictEqual([403, 403, 403]);
  });
});

describe('POST /account/password', () => {
  it('ID-15 needs a fresh re-authentication', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const csrf = csrfOf(await pageText(browser, '/account'));
    const response = await browser.submit('/account/password', {
      csrf,
      password: 'a brand new passphrase',
    });
    expect(response.status).toBe(403);
    expect(harness.audits.at(-1)?.details?.['reason']).toBe('re-authentication required');
  });

  it('ID-5 ID-15 applies the policy, then changes the password and ends every other session', async () => {
    const harness = createHarness();
    const { browser, csrf, key } = await confirmedBrowser(harness);
    harness.advance(60_000);
    const other = await signIn(harness, totpFor(key, harness.now()));
    const weak = await browser.submit('/account/password', { csrf, password: 'short' });
    const changed = await browser.submit('/account/password', {
      csrf,
      password: 'a brand new passphrase',
    });
    const otherAfter = await other.get('/account');
    const selfAfter = await browser.get('/account?notice=password-changed');
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain('use at least 12 characters');
    expect(changed.status).toBe(303);
    expect(otherAfter.status).toBe(303);
    expect(selfAfter.status).toBe(200);
    expect(await selfAfter.text()).toContain('Password changed.');
    expect(harness.stores.operators.findAny()?.passwordChangedAt).toBe(harness.now());
    expect(harness.audits.at(-1)?.action).toBe('password.changed');
  });
});

describe('POST /account/totp/rotate', () => {
  it('ID-9 ID-15 shows a new key, then switches only after a code from it is accepted', async () => {
    const harness = createHarness();
    const { browser, csrf, key } = await confirmedBrowser(harness);
    const shown = await browser.submit('/account/totp/rotate', { csrf });
    const newKey = enrolmentKeyOf(await shown.text());
    const wrong = await browser.submit('/account/totp/rotate', {
      csrf,
      code: totpFor(key, harness.now()),
    });
    const right = await browser.submit('/account/totp/rotate', {
      csrf,
      code: totpFor(newKey, harness.now()),
    });
    const notice = await pageText(browser, '/account?notice=totp-rotated');
    harness.advance(60_000);
    const oldKeyLogin = await signIn(harness, totpFor(key, harness.now()));
    const newKeyLogin = await signIn(harness, totpFor(newKey, harness.now()));
    const oldStatus = await statusOf(oldKeyLogin, '/account');
    const newStatus = await statusOf(newKeyLogin, '/account');
    expect(shown.status).toBe(200);
    expect(newKey).not.toBe(key);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('the code was not accepted');
    expect(right.status).toBe(303);
    expect(notice).toContain('Your authenticator has been replaced.');
    expect(browser.cookies.has('__Host-vg_state')).toBe(false);
    expect([oldStatus, newStatus]).toStrictEqual([303, 200]);
  });

  it('ID-18 refuses a code without a pending enrolment', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmedBrowser(harness);
    const response = await browser.submit('/account/totp/rotate', { csrf, code: '123456' });
    expect(response.status).toBe(403);
    expect(harness.audits.at(-1)?.details?.['reason']).toBe('no pending authenticator');
  });
});

describe('POST /account/recovery-codes', () => {
  it('ID-11 ID-15 replaces the codes and shows the new set once', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmedBrowser(harness);
    const operatorId = harness.stores.operators.findAny()?.id ?? '';
    const response = await browser.submit('/account/recovery-codes', { csrf });
    const codes = recoveryCodesOf(await response.text());
    const hashes = codes.map((code) => hashRecoveryCode(code));
    const consumed = hashes.map((hash) =>
      harness.stores.recoveryCodes.consume(operatorId, hash, 1),
    );
    expect(response.status).toBe(200);
    expect(codes).toHaveLength(8);
    expect(consumed).toStrictEqual([true, true, true, true, true, true, true, true]);
    expect(harness.audits.at(-1)?.action).toBe('recovery-codes.regenerated');
  });
});
