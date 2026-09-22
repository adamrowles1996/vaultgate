import { describe, expect, it } from 'vitest';

import {
  createHarness,
  csrfOf,
  DISPLAY_NAME,
  enrolmentKeyOf,
  pageText,
  PASSWORD,
  recoveryCodesOf,
  setUpOperator,
  totpFor,
} from '../test-support/identity-app.ts';

import { hashBootstrapToken } from './bootstrap.ts';
import { CONTENT_SECURITY_POLICY } from './browser.ts';

describe('bootstrap', () => {
  it('ID-1 mints a 32-byte token, stores its hash with a 30 minute expiry and logs the URL once', () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    harness.identity.bootstrap.ensureToken();
    const token = harness.setupToken();
    const messages = harness.logged().map((line) => line['msg']);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(messages).toStrictEqual([
      `Open https://vault.example.com/setup?token=${token} to create the operator account`,
    ]);
    const hash = hashBootstrapToken(token);
    expect(harness.stores.bootstrapTokens.isUsable(hash, harness.now() + 30 * 60_000 - 1)).toBe(
      true,
    );
    expect(harness.stores.bootstrapTokens.isUsable(hash, harness.now() + 30 * 60_000)).toBe(false);
  });

  it('ID-2 uses the preset token when configured', () => {
    const preset = 'preset-'.repeat(3);
    const harness = createHarness({ bootstrapToken: preset });
    harness.identity.bootstrap.ensureToken();
    expect(harness.setupToken()).toBe(preset);
    expect(harness.identity.bootstrap.isTokenUsable(preset)).toBe(true);
    expect(harness.identity.bootstrap.isTokenUsable(undefined)).toBe(false);
  });

  it('ID-1 mints nothing once an operator exists', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const before = harness.logged().length;
    harness.identity.bootstrap.ensureToken();
    expect(harness.logged().length).toBe(before);
  });
});

describe('GET /setup', () => {
  it('ID-3 renders the same generic page without a token and with a bad one', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const missing = await browser.get('/setup');
    const wrong = await browser.get('/setup?token=nope');
    const missingText = await missing.text();
    expect(missing.status).toBe(200);
    expect(wrong.status).toBe(200);
    expect(missingText).toBe(await wrong.text());
    expect(missingText).toContain('Open the setup link printed in the server log');
    expect(browser.cookies.size).toBe(0);
  });

  it('ID-9 ID-19 ID-20 shows the enrolment key and URI as text under a strict CSP', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const response = await browser.get(`/setup?token=${harness.setupToken()}`);
    const markup = await response.text();
    const key = enrolmentKeyOf(markup);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    expect(markup).toContain(
      `otpauth://totp/vaultgate%3Aoperator?secret=${key}&amp;issuer=vaultgate`,
    );
    expect(markup).not.toContain('<script');
    expect(browser.cookies.has('__Host-vg_state')).toBe(true);
  });
});

describe('POST /setup', () => {
  it('ID-3 ID-11 ID-14 creates the operator, shows eight recovery codes once and signs in', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const form = await browser.get(`/setup?token=${harness.setupToken()}`);
    const markup = await form.text();
    const key = enrolmentKeyOf(markup);
    const done = await browser.submit('/setup', {
      token: harness.setupToken(),
      csrf: csrfOf(markup),
      display_name: ` ${DISPLAY_NAME} `,
      password: PASSWORD,
      code: totpFor(key, harness.now()),
    });
    const codes = recoveryCodesOf(await done.text());
    const cookie = done.headers.getSetCookie().find((c) => c.startsWith('__Host-vg_session='));
    expect(done.status).toBe(200);
    expect(codes).toHaveLength(8);
    expect(cookie).toMatch(
      /^__Host-vg_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=43200$/,
    );
    expect(browser.cookies.has('__Host-vg_state')).toBe(false);
    expect(harness.stores.operators.findAny()?.displayName).toBe(DISPLAY_NAME);
    expect(
      harness.stores.recoveryCodes.countUnused(harness.stores.operators.findAny()?.id ?? ''),
    ).toBe(8);
    expect(harness.audits.map((event) => event.action)).toStrictEqual(['operator.created']);
    const account = await browser.get('/account');
    expect(account.status).toBe(200);
  });

  it('ID-3 ID-5 re-renders with the reason for a bad name, password or code', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const markup = await pageText(browser, `/setup?token=${harness.setupToken()}`);
    const key = enrolmentKeyOf(markup);
    const base = { token: harness.setupToken(), csrf: csrfOf(markup), display_name: DISPLAY_NAME };
    const good = totpFor(key, harness.now());
    const commonPassword = ['123', 'qwe', 'asd', 'zxc'].join('');
    const attempts = [
      { ...base, display_name: ' '.repeat(3), password: PASSWORD, code: good },
      { ...base, display_name: 'x'.repeat(65), password: PASSWORD, code: good },
      { ...base, password: 'short', code: good },
      { ...base, password: commonPassword, code: good },
      { ...base, password: PASSWORD, code: '000000' },
    ];
    const responses = [];
    for (const fields of attempts) {
      const response = await browser.submit('/setup', fields);
      responses.push({ status: response.status, text: await response.text() });
    }
    expect(responses.map((r) => r.status)).toStrictEqual([400, 400, 400, 400, 400]);
    expect(responses.map((r) => /role="alert">([^<]+)</.exec(r.text)?.[1])).toStrictEqual([
      'enter a display name of up to 64 characters',
      'enter a display name of up to 64 characters',
      'use at least 12 characters',
      'that password is on the list of most common passwords',
      'the authenticator code was not accepted',
    ]);
    expect(responses.every((r) => r.text.includes(key))).toBe(true);
    expect(harness.stores.operators.count()).toBe(0);
  });

  it('ID-18 refuses a missing state cookie, a foreign origin, a stale token or login-flow state', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const markup = await pageText(browser, `/setup?token=${harness.setupToken()}`);
    const fields = {
      token: harness.setupToken(),
      csrf: csrfOf(markup),
      display_name: DISPLAY_NAME,
      password: PASSWORD,
      code: '000000',
    };
    const foreign = await browser.submit('/setup', fields, { origin: 'https://evil.example' });
    const staleCsrf = await browser.submit('/setup', { ...fields, csrf: 'nope' });
    const stateCookie = browser.cookies.get('__Host-vg_state') ?? '';
    browser.cookies.delete('__Host-vg_state');
    const noState = await browser.submit('/setup', fields);
    const loginPage = await browser.get('/login');
    const loginState = await browser.submit('/setup', {
      ...fields,
      csrf: csrfOf(await loginPage.text()),
    });
    browser.cookies.set('__Host-vg_state', stateCookie);
    const jsonBody = await browser.postRaw('/setup', '{}', 'application/json');
    expect([
      foreign.status,
      staleCsrf.status,
      noState.status,
      loginState.status,
      jsonBody.status,
    ]).toStrictEqual([403, 403, 403, 403, 403]);
    expect(harness.audits.map((event) => event.details?.['reason'])).toStrictEqual([
      'cross-origin request',
      'missing or stale synchroniser token',
      'missing browser state',
      'missing enrolment state',
      'missing or stale synchroniser token',
    ]);
    expect(harness.audits[0]?.ip).toBe('203.0.113.7');
  });

  it('ID-3 treats absent fields as empty', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const markup = await pageText(browser, `/setup?token=${harness.setupToken()}`);
    const csrf = csrfOf(markup);
    const noToken = await browser.submit('/setup', { csrf });
    const noName = await browser.submit('/setup', { csrf, token: harness.setupToken() });
    const noPassword = await browser.submit('/setup', {
      csrf,
      token: harness.setupToken(),
      display_name: DISPLAY_NAME,
    });
    const noCode = await browser.submit('/setup', {
      csrf,
      token: harness.setupToken(),
      display_name: DISPLAY_NAME,
      password: PASSWORD,
    });
    expect([noToken.status, noName.status, noPassword.status, noCode.status]).toStrictEqual([
      400, 400, 400, 400,
    ]);
    expect(await noToken.text()).toContain('enter a display name of up to 64 characters');
    expect(await noCode.text()).toContain('the authenticator code was not accepted');
  });

  it('ID-3 refuses a token that is invalid at submission time', async () => {
    const harness = createHarness();
    harness.identity.bootstrap.ensureToken();
    const browser = harness.browser();
    const markup = await pageText(browser, `/setup?token=${harness.setupToken()}`);
    const key = enrolmentKeyOf(markup);
    const response = await browser.submit('/setup', {
      token: 'wrong',
      csrf: csrfOf(markup),
      display_name: DISPLAY_NAME,
      password: PASSWORD,
      code: totpFor(key, harness.now()),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Open the setup link printed in the server log');
    expect(harness.stores.operators.count()).toBe(0);
  });

  it('ID-4 answers 404 for every request once an operator exists', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const browser = harness.browser();
    const get = await browser.get(`/setup?token=${harness.setupToken()}`);
    const post = await browser.submit('/setup', {});
    expect(get.status).toBe(404);
    expect(post.status).toBe(404);
  });
});

describe('static assets', () => {
  it('ID-19 serves the single stylesheet', async () => {
    const harness = createHarness();
    const response = await harness.browser().get('/static/vaultgate.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await response.text()).toContain('font-family');
  });
});
