import { describe, expect, it } from 'vitest';

import { StoreAuditSink } from '../audit/store-sink.ts';
import { insertCallRow } from '../test-support/actions-store-fixtures.ts';
import {
  createHarness,
  csrfOf,
  type Harness,
  pageText,
  PASSWORD,
  setUpOperator,
} from '../test-support/identity-app.ts';
import { captureLogger } from '../test-support/logging.ts';

import type { Browser } from '../test-support/browser.ts';

const FROM = '2026-09-01';
const TO = '2026-10-01';

/**
Two persisted events an hour apart, as the server's own sink would have written them.
*/
function seedTrail(harness: Harness): void {
  const clock = { now: harness.now() - 3_600_000 };
  let ids = 0;
  const sink = new StoreAuditSink({
    database: harness.database,
    logger: captureLogger().logger,
    now: () => clock.now,
    newId: () => {
      ids += 1;
      return `event-${ids}`;
    },
  });
  sink.record({
    category: 'identity',
    action: 'login.succeeded',
    outcome: 'ok',
    operatorId: 'operator-1',
    details: { method: 'totp' },
  });
  clock.now += 3_600_000;
  sink.record({ category: 'mcp', action: 'get_item', outcome: 'ok', itemId: 'item-1' });
}

async function confirmed(harness: Harness): Promise<{ browser: Browser; csrf: string }> {
  const { browser } = await setUpOperator(harness);
  const csrf = csrfOf(await pageText(browser, '/account'));
  await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
  return { browser, csrf };
}

describe('GET /account/activity audit log section', () => {
  it('ID-15 OPS-5 offers the export form only after re-authentication', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const before = await pageText(browser, '/account/activity');
    const csrf = csrfOf(before);
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    const after = await pageText(browser, '/account/activity');
    expect(before).toContain(
      'href="/account/unlock?next=%2Faccount%2Factivity">Confirm your password</a>',
    );
    expect(before).not.toContain('action="/account/audit/export"');
    expect(after).toContain('action="/account/audit/export"');
    expect(after).toContain('<option value="csv">CSV</option>');
    expect(after).toContain('<option value="actions">Action calls</option>');
  });
});

describe('POST /account/audit/export', () => {
  it('ID-15 needs a fresh re-authentication', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const csrf = csrfOf(await pageText(browser, '/account'));
    const response = await browser.submit('/account/audit/export', { csrf, from: FROM, to: TO });
    expect(response.status).toBe(403);
    expect(harness.audits.at(-1)?.details?.['reason']).toBe('re-authentication required');
  });

  it('ID-18 refuses without a session', async () => {
    const harness = createHarness();
    const response = await harness
      .browser()
      .submit('/account/audit/export', { from: FROM, to: TO });
    expect(response.status).toBe(403);
  });

  it('OPS-5 downloads the window as JSON Lines, newest first, and audits the export', async () => {
    const harness = createHarness();
    seedTrail(harness);
    const { browser, csrf } = await confirmed(harness);
    const response = await browser.submit('/account/audit/export', { csrf, from: FROM, to: TO });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/jsonl; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="vaultgate-audit-20260901T000000Z-20261001T000000Z.jsonl"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.split('\n')).toStrictEqual([
      '{"id":"event-2","at":"2026-09-22T12:00:00.000Z","category":"mcp","action":"get_item","outcome":"ok","itemId":"item-1"}',
      '{"id":"event-1","at":"2026-09-22T11:00:00.000Z","category":"identity","action":"login.succeeded","outcome":"ok","operatorId":"operator-1","details":{"method":"totp"}}',
      '',
    ]);
    expect(harness.audits.at(-1)).toMatchObject({
      action: 'audit.exported',
      outcome: 'ok',
      details: {
        format: 'jsonl',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      },
    });
  });

  it('OPS-5 downloads CSV with the header row and RFC 4180 line ends', async () => {
    const harness = createHarness();
    seedTrail(harness);
    const { browser, csrf } = await confirmed(harness);
    const response = await browser.submit('/account/audit/export', {
      csrf,
      from: '2026-09-22T11:30:00Z',
      to: TO,
      format: 'csv',
    });
    const body = await response.text();
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="vaultgate-audit-20260922T113000Z-20261001T000000Z.csv"',
    );
    expect(body).toBe(
      'id,at,category,action,outcome,operatorId,clientId,tokenPrefix,itemId,field,requestId,ip,durationMs,details\r\n' +
        'event-2,2026-09-22T12:00:00.000Z,mcp,get_item,ok,,,,item-1,,,,,\r\n',
    );
  });

  it('ACT-62 downloads the action calls of the window as the actions stream, in both formats', async () => {
    const harness = createHarness();
    insertCallRow(harness.database, { at: harness.now(), targetId: 'target-1', revision: 2 });
    const { browser, csrf } = await confirmed(harness);
    const jsonl = await browser.submit('/account/audit/export', {
      csrf,
      from: FROM,
      to: TO,
      stream: 'actions',
    });
    const body = await jsonl.text();
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get('content-disposition')).toBe(
      'attachment; filename="vaultgate-actions-20260901T000000Z-20261001T000000Z.jsonl"',
    );
    expect(body.split('\n')).toStrictEqual([
      String.raw`{"id":"call-1","at":"2026-09-22T12:00:00.000Z","targetId":"target-1","targetName":"api","connector":"http","revision":2,"tool":"http_request","clientId":"vg_c_agent","tokenPrefix":"aabbccdd0011","operation":"read","classification":"GET","arguments":"{\"target\":\"api\",\"method\":\"GET\",\"path\":\"/v1/me\"}","argumentsTruncated":false,"outputBytes":12,"outputTruncated":false,"durationMs":3,"outcome":"ok","elicitation":"not_required","requestId":"req-1","ip":"203.0.113.9"}`,
      '',
    ]);
    expect(harness.audits.at(-1)).toMatchObject({
      action: 'audit.exported',
      details: { format: 'jsonl', stream: 'actions' },
    });
    const csv = await browser.submit('/account/audit/export', {
      csrf,
      from: FROM,
      to: TO,
      format: 'csv',
      stream: 'actions',
    });
    const rows = await csv.text();
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="vaultgate-actions-20260901T000000Z-20261001T000000Z.csv"',
    );
    expect(rows.split('\r\n', 1)[0]).toBe(
      'id,at,targetId,targetName,connector,revision,tool,sessionIdHash,clientId,tokenPrefix,operation,classification,arguments,argumentsTruncated,outputBytes,outputTruncated,durationMs,outcome,elicitation,confirmationNonce,requestId,ip',
    );
    expect(rows.split('\r\n')).toHaveLength(3);
    const unknown = await browser.submit('/account/audit/export', {
      csrf,
      from: FROM,
      to: TO,
      stream: 'nope',
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('stream must be audit or actions, not nope');
  });

  it('shows the account page with the problem when the window is invalid', async () => {
    const harness = createHarness();
    const { browser, csrf } = await confirmed(harness);
    const response = await browser.submit('/account/audit/export', { csrf, from: TO, to: FROM });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      '<p class="error" role="alert">from must be before to</p>',
    );
    expect(harness.audits.map((event) => event.action)).not.toContain('audit.exported');
  });
});
