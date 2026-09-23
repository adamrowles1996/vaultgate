import { describe, expect, it } from 'vitest';

import {
  createHarness,
  csrfOf,
  EMAIL,
  pageText,
  PASSWORD,
  setUpOperator,
  statusOf,
  totpFor,
} from '../test-support/identity-app.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('sessions', () => {
  it('ID-14 expires after an hour idle, refreshes on activity and ends at twelve hours', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const statuses: number[] = [];
    for (const step of [50 * MINUTE, 50 * MINUTE, 50 * MINUTE]) {
      harness.advance(step);
      statuses.push(await statusOf(browser, '/account'));
    }
    harness.advance(HOUR);
    statuses.push(await statusOf(browser, '/account'));
    expect(statuses).toStrictEqual([200, 200, 200, 303]);
    expect(
      harness.stores.sessions.listForOperator(harness.stores.operators.findAny()?.id ?? ''),
    ).toStrictEqual([]);
  });

  it('ID-14 never outlives the absolute limit however active', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const statuses: number[] = [];
    for (let elapsed = 0; elapsed < 12 * HOUR; elapsed += 30 * MINUTE) {
      harness.advance(30 * MINUTE);
      statuses.push(await statusOf(browser, '/account'));
    }
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(303);
  });

  it('ID-16 drops the __Host- prefix and Secure on plain-http loopback and warns once', async () => {
    const harness = createHarness({ publicUrl: 'http://localhost:8080' });
    const { browser } = await setUpOperator(harness);
    const warnings = harness
      .logged()
      .filter((line) => line['level'] === 40)
      .map((line) => line['msg']);
    expect(browser.cookies.has('vg_session')).toBe(true);
    expect(warnings).toStrictEqual([
      'VAULTGATE_PUBLIC_URL is plain http: session cookies are sent without Secure or the __Host- prefix (development only)',
    ]);
    const account = await browser.get('/account');
    expect(account.status).toBe(200);
  });

  it('OPS-6 records the forwarded address only when the proxy is trusted', async () => {
    const trusted = createHarness({ trustProxy: true });
    const { browser } = await setUpOperator(trusted);
    await browser.submit(
      '/logout',
      { csrf: 'wrong' },
      { headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.9' } },
    );
    await browser.submit('/logout', { csrf: 'wrong' }, { headers: { 'x-forwarded-for': '' } });
    const untrusted = createHarness();
    const { browser: other } = await setUpOperator(untrusted);
    await other.submit(
      '/logout',
      { csrf: 'wrong' },
      { headers: { 'x-forwarded-for': '198.51.100.9' } },
    );
    expect(trusted.audits.map((event) => event.ip)).toStrictEqual([
      '203.0.113.7',
      '198.51.100.9',
      '203.0.113.7',
    ]);
    expect(untrusted.audits.map((event) => event.ip)).toStrictEqual(['203.0.113.7', '203.0.113.7']);
  });
});

describe('POST /login/verify without state', () => {
  it('ID-18 refuses the second step without its state cookie', async () => {
    const harness = createHarness();
    await setUpOperator(harness);
    const response = await harness.browser().submit('/login/verify', { csrf: 'x', code: '1' });
    expect(response.status).toBe(403);
  });

  it('ID-14 ends a session that was already present when the login completes', async () => {
    const harness = createHarness();
    const { browser: earlier, key } = await setUpOperator(harness);
    harness.advance(MINUTE);
    const later = harness.browser();
    const csrf = csrfOf(await pageText(later, '/login'));
    later.cookies.set('__Host-vg_session', earlier.cookies.get('__Host-vg_session') ?? '');
    await later.submit('/login', { csrf, email: EMAIL, password: PASSWORD });
    const done = await later.submit('/login/verify', { csrf, code: totpFor(key, harness.now()) });
    const earlierStatus = await statusOf(earlier, '/account');
    const laterStatus = await statusOf(later, '/account');
    expect(done.status).toBe(303);
    expect([earlierStatus, laterStatus]).toStrictEqual([303, 200]);
  });
});

describe('POST /logout', () => {
  it('ID-17 ID-18 deletes the session and clears the cookie, given the synchroniser token', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const csrf = csrfOf(await pageText(browser, '/account'));
    const foreign = await browser.submit('/logout', { csrf }, { origin: false });
    const done = await browser.submit('/logout', { csrf });
    const cleared = done.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Host-vg_session='));
    const after = await browser.get('/account');
    const anonymous = await harness.browser().submit('/logout', {});
    expect(foreign.status).toBe(403);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/login');
    expect(cleared).toBe('__Host-vg_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
    expect(after.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/login');
    expect(harness.audits.map((event) => event.action)).toStrictEqual([
      'operator.created',
      'request.denied',
      'logout',
    ]);
  });

  it('ID-18 reads a multipart form and ignores file parts', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const form = new FormData();
    form.set('csrf', csrfOf(await pageText(browser, '/account')));
    form.set('attachment', new Blob(['not a field']), 'x.txt');
    const done = await browser.postMultipart('/logout', form);
    expect(done.status).toBe(303);
  });
});
