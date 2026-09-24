import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all } from '../storage/query.ts';
import {
  createHarness,
  csrfOf,
  EMAIL,
  pageText,
  PASSWORD,
  setUpOperator,
  signIn,
  totpFor,
} from '../test-support/identity-app.ts';
import { fixedRandom } from '../test-support/identity.ts';

import { LOGIN_FAILURE_MESSAGE } from './pages/login.ts';
import { hashPassword } from './password.ts';

const MINUTE = 60_000;
const subjectSchema = z.object({ subject: z.string() });

describe('GET /login', () => {
  it('ID-12 ID-18 renders the password step with a synchroniser token and a state cookie', async () => {
    const harness = createHarness();
    const browser = harness.browser();
    const response = await browser.get('/login');
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(csrfOf(markup)).toMatch(/^[\w-]{43}$/);
    expect(markup).toContain('name="next" value="/account/agents"');
    expect(browser.cookies.has('__Host-vg_state')).toBe(true);
  });

  it('ID-14 sends a signed-in operator straight on', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const response = await browser.get('/login?next=%2Foauth%2Fauthorize%2Fabc');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/oauth/authorize/abc');
  });
});

describe('POST /login', () => {
  it('ID-12 answers an unknown, malformed or wrong e-mail and a wrong password identically', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    const unknown = await browser.submit('/login', {
      csrf,
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    const malformed = await browser.submit('/login', { csrf, email: 'nobody', password: PASSWORD });
    const wrong = await browser.submit('/login', {
      csrf,
      email: EMAIL,
      password: 'not it',
    });
    const unknownText = await unknown.text();
    expect([unknown.status, malformed.status, wrong.status]).toStrictEqual([401, 401, 401]);
    expect(unknownText).toBe(await malformed.text());
    expect(unknownText).toBe(await wrong.text());
    expect(unknownText).toContain(LOGIN_FAILURE_MESSAGE);
    expect(unknownText).toContain('name="email"');
    expect(harness.audits.map((event) => event.details)).toStrictEqual([
      { email: EMAIL },
      { step: 'password', email: 'nobody@example.com' },
      { step: 'password' },
      { step: 'password', email: EMAIL },
    ]);
    expect(harness.delays).toStrictEqual([0, 0, 0]);
  });

  it('ID-12 moves to the second step after the password and refuses the second step without it', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    const early = await browser.submit('/login/verify', { csrf, code: '000000' });
    const step = await browser.submit('/login', {
      csrf,
      email: EMAIL,
      password: PASSWORD,
    });
    const markup = await step.text();
    expect(early.status).toBe(403);
    expect(step.status).toBe(200);
    expect(markup).toContain('action="/login/verify"');
    expect(csrfOf(markup)).toBe(csrf);
  });

  it('ID-6 upgrades a hash stored with weaker parameters on login', async () => {
    const harness = createHarness();
    const { key } = await setUpOperator(harness);
    const operator = harness.stores.operators.findAny();
    const weak = await hashPassword(PASSWORD, fixedRandom(), {
      cost: 2 ** 4,
      blockSize: 4,
      parallelism: 1,
    });
    harness.stores.operators.updatePasswordHash(operator?.id ?? '', weak, 1);
    await signIn(harness, totpFor(key, harness.now()));
    const upgraded = harness.stores.operators.findAny();
    expect(upgraded?.passwordHash.startsWith('scrypt$16$8$1$')).toBe(true);
    expect(upgraded?.passwordChangedAt).toBe(1);
    expect(upgraded?.passwordHash).not.toBe(weak);
  });

  it('ID-18 refuses a form without its state cookie', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    browser.cookies.delete('__Host-vg_state');
    const response = await browser.submit('/login', {
      csrf,
      email: EMAIL,
      password: PASSWORD,
    });
    expect(response.status).toBe(403);
  });
});

describe('POST /login/verify', () => {
  it('ID-10 ID-14 accepts a TOTP code once, rotates the session and records the client', async () => {
    const harness = createHarness();
    const { key } = await setUpOperator(harness);
    harness.advance(MINUTE);
    const code = totpFor(key, harness.now());
    const first = await signIn(harness, code);
    const replay = harness.browser();
    const csrf = csrfOf(await pageText(replay, '/login'));
    await replay.submit('/login', { csrf, email: EMAIL, password: PASSWORD });
    const replayed = await replay.submit(
      '/login/verify',
      { csrf, code },
      { headers: { 'user-agent': 'Second browser' } },
    );
    const account = await first.get('/account');
    const sessions = harness.stores.sessions.listForOperator(
      harness.stores.operators.findAny()?.id ?? '',
    );
    expect(replayed.status).toBe(401);
    expect(await replayed.text()).toContain(LOGIN_FAILURE_MESSAGE);
    expect(account.status).toBe(200);
    expect(sessions.map((session) => session.ip)).toStrictEqual(['203.0.113.7', '203.0.113.7']);
    expect(harness.audits.filter((event) => event.action === 'login.succeeded')).toHaveLength(1);
    expect(harness.audits.at(-1)?.details).toStrictEqual({ step: 'second-factor', email: EMAIL });
  });

  it('ID-11 accepts each recovery code once', async () => {
    const harness = createHarness();
    const { recoveryCodes } = await setUpOperator(harness);
    const code = recoveryCodes[0] ?? '';
    const browser = await signIn(harness, code.toLowerCase());
    const again = await signIn(harness, code);
    const signedIn = await browser.get('/account');
    const refused = await again.get('/account');
    expect(signedIn.status).toBe(200);
    expect(refused.status).toBe(303);
    expect(
      harness.audits
        .filter((event) => event.action === 'login.succeeded')
        .map((event) => event.details),
    ).toStrictEqual([{ method: 'recovery', email: EMAIL }]);
  });

  it('ID-14 honours a safe next path and ignores an unsafe one', async () => {
    const harness = createHarness();
    const { key } = await setUpOperator(harness);
    harness.advance(MINUTE);
    const safe = harness.browser();
    const safePage = await safe.get('/login?next=%2Foauth%2Fauthorize%2Fx');
    const safeCsrf = csrfOf(await safePage.text());
    await safe.submit('/login', { csrf: safeCsrf, email: EMAIL, password: PASSWORD });
    const safeDone = await safe.submit('/login/verify', {
      csrf: safeCsrf,
      code: totpFor(key, harness.now()),
      next: '/oauth/authorize/x',
    });
    harness.advance(MINUTE);
    const unsafe = harness.browser();
    const unsafeCsrf = csrfOf(await pageText(unsafe, '/login'));
    await unsafe.submit('/login', {
      csrf: unsafeCsrf,
      email: EMAIL,
      password: PASSWORD,
    });
    const unsafeDone = await unsafe.submit('/login/verify', {
      csrf: unsafeCsrf,
      code: totpFor(key, harness.now()),
      next: '//evil.example/x',
    });
    expect(safeDone.headers.get('location')).toBe('/oauth/authorize/x');
    expect(unsafeDone.headers.get('location')).toBe('/account/agents');
  });

  it('ID-12 refuses when the operator vanished or has no authenticator secret', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const operator = harness.stores.operators.findAny();
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    await browser.submit('/login', { csrf, email: EMAIL, password: PASSWORD });
    harness.database.exec('UPDATE operators SET totp_secret_ciphertext = NULL');
    const noSecret = await browser.submit('/login/verify', { csrf, code: '123456' });
    harness.database.exec('DELETE FROM operators');
    const gone = await browser.submit('/login/verify', { csrf, code: '123456' });
    expect(operator).toBeDefined();
    expect([noSecret.status, gone.status]).toStrictEqual([401, 403]);
  });

  it('ID-13 backs off after five failures for the address or the account', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const browser = harness.browser();
    const csrf = csrfOf(await pageText(browser, '/login'));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await browser.submit('/login', { csrf, email: EMAIL, password: 'wrong' });
    }
    await browser.submit('/login', { csrf, email: 'somebody.else@example.com', password: 'wrong' });
    harness.advance(15 * MINUTE);
    const fresh = csrfOf(await pageText(browser, '/login'));
    await browser.submit('/login', { csrf: fresh, email: EMAIL, password: 'wrong' });
    expect(harness.delays).toStrictEqual([0, 0, 0, 0, 0, 1000, 2000, 0]);
    const subjects = new Set(
      all(harness.database, 'SELECT subject FROM login_attempts', subjectSchema).map(
        (row) => row.subject,
      ),
    );
    expect([...subjects].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      `email:${EMAIL}`,
      'email:somebody.else@example.com',
      'ip:203.0.113.7',
    ]);
  });
});
