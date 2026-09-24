import { describe, expect, it } from 'vitest';

import {
  type ActionsHarness,
  caller,
  CLIENT_ID,
  confirmationOf,
  createHttpTarget,
  httpInvocation,
  OPERATOR_ID,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact } from '../../test-support/identity-app.ts';

import { parseCursor } from './calls.ts';

import type { Browser } from '../../test-support/browser.ts';

const WRITABLE = {
  policy: { allowed_methods: ['GET', 'POST'], rate_limit_per_minute: 600 },
} as const;

async function pageMarkup(browser: Browser, path: string): Promise<string> {
  const page = await browser.get(path);
  return page.text();
}

/**
One call per tick, so the rows are ordered by time rather than by identifier.
*/
async function callTimes(
  actions: ActionsHarness,
  count: number,
  toolArguments: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await actions.engine.call(caller(), httpInvocation(toolArguments));
    await actions.clock.advance(1000);
  }
}

function rowsOf(markup: string): readonly string[] {
  return markup.split('<tr>').slice(2);
}

describe('GET /account/actions/:id/calls', () => {
  it('ACT-63 pages a target’s calls 50 at a time, newest first, and links to the older ones', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, WRITABLE);
    await callTimes(harness.actions, 51);
    const { browser } = await signedInOperator(harness);
    const first = await pageMarkup(browser, `/account/actions/${target.id}/calls`);
    expect(first).toContain('<title>Calls of api · vaultgate</title>');
    expect(rowsOf(first)).toHaveLength(50);
    // The newest row is the last call made, at 12:00:50.
    expect(first).toContain('data-label="Time">2026-09-22T12:00:50.000Z</td>');
    expect(first).not.toContain('data-label="Time">2026-09-22T12:00:00.000Z</td>');
    const older = /href="([^"]*\/calls\?before=[^"]*)"/.exec(first)?.[1] ?? '';
    expect(older).not.toBe('');
    const second = await pageMarkup(browser, older.replaceAll('&amp;', '&'));
    expect(rowsOf(second)).toHaveLength(1);
    expect(second).toContain('data-label="Time">2026-09-22T12:00:00.000Z</td>');
    expect(second).toContain('This is the whole trail kept for these calls.');
  });

  it('ACT-63 shows a target with no call as such and offers the history from its page', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness);
    const page = await pageMarkup(browser, `/account/actions/${target.id}`);
    expect(page).toContain(`<a class="button small" href="/account/actions/${target.id}/calls">`);
    const history = await pageMarkup(browser, `/account/actions/${target.id}/calls`);
    expect(history).toContain('<p class="empty">No calls yet.</p>');
  });

  it('ACT-63 answers 404 for an unknown target and sends a visitor with no session to the login form', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const missing = await browser.get('/account/actions/nope/calls');
    expect(missing.status).toBe(404);
    const anonymous = await harness.app.app.request('/account/actions/nope/calls');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(
      '/login?next=%2Faccount%2Factions%2Fnope%2Fcalls',
    );
  });
});

describe('GET /account/actions/unexpected', () => {
  it('ACT-63 lists every non-read call no human accepted, across targets, with the arguments excerpt', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions, WRITABLE);
    await createHttpTarget(harness.actions, {
      ...WRITABLE,
      name: 'other',
      base_url: 'https://other.example.com',
    });
    await harness.actions.engine.call(caller(), httpInvocation({ method: 'POST', body: 'x' }));
    await harness.actions.clock.advance(1000);
    await harness.actions.engine.call(
      caller(),
      httpInvocation({ target: 'other', method: 'POST', path: '/v1/pay', body: 'y' }),
    );
    const { browser } = await signedInOperator(harness);
    const markup = await pageMarkup(browser, '/account/actions/unexpected');
    expect(markup).toContain('<title>Unexpected writes · vaultgate</title>');
    expect(rowsOf(markup)).toHaveLength(2);
    expect(markup).toContain(
      'data-label="Computer"><a class="mono" href="/account/actions/id-1">api</a>',
    );
    expect(markup).toContain(
      'data-label="Computer"><a class="mono" href="/account/actions/id-2">other</a>',
    );
    expect(markup).toContain(`data-label="Agent">${CLIENT_ID}</td>`);
    expect(markup).toContain('data-label="Classification">POST</td>');
    expect(markup).toContain('&quot;path&quot;:&quot;/v1/pay&quot;');
    expect(markup).toContain('This is the whole trail kept for these calls.');
  });

  it('ACT-63 leaves out reads and the writes a human accepted, and keeps a deleted target’s calls', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, {
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
    });
    await harness.actions.engine.call(caller(), httpInvocation());
    const post = httpInvocation({ method: 'POST', body: 'x' });
    const pending = confirmationOf(await harness.actions.engine.call(caller(), post));
    await harness.actions.engine.call(
      caller({
        confirmation: {
          requestState: pending.requestState,
          result: { action: 'accept', content: { confirm: true } },
        },
      }),
      post,
    );
    const { browser } = await signedInOperator(harness);
    expect(await pageMarkup(browser, '/account/actions/unexpected')).toContain(
      'No unexpected write has been recorded.',
    );
    const second = httpInvocation({ method: 'POST', body: 'y' });
    const declined = confirmationOf(await harness.actions.engine.call(caller(), second));
    await harness.actions.engine.call(
      caller({
        confirmation: { requestState: declined.requestState, result: { action: 'decline' } },
      }),
      second,
    );
    harness.actions.engine.targets.remove(target.id, OPERATOR_ID);
    const markup = await pageMarkup(browser, '/account/actions/unexpected');
    expect(rowsOf(markup)).toHaveLength(1);
    expect(markup).toContain('data-label="Computer"><span class="mono">api</span></td>');
    expect(markup).not.toContain('data-label="Computer"><a');
  });

  it('ACT-5 sends a visitor with no session to the login form and links the view from the Activity page', async () => {
    const harness = createPagesHarness();
    const anonymous = await harness.app.app.request('/account/actions/unexpected');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/login?next=%2Faccount%2Factions%2Funexpected');
    const { browser } = await signedInOperator(harness);
    expect(await pageMarkup(browser, '/account/activity')).toContain(
      '<a class="button small" href="/account/actions/unexpected">Unexpected writes',
    );
  });

  it('ACT-61 cuts a long arguments record in the table and marks the cut', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions, WRITABLE);
    await harness.actions.engine.call(
      caller(),
      httpInvocation({ method: 'POST', body: 'z'.repeat(400) }),
    );
    const { browser } = await signedInOperator(harness);
    const markup = await pageMarkup(browser, '/account/actions/unexpected');
    expect(markup).toContain('…</code>');
    expect(markup).not.toContain('z'.repeat(400));
  });
});

describe('the older-calls cursor', () => {
  it('ACT-63 accepts only a whole number and an identifier, so a tampered link starts afresh', () => {
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor('1700000000000')).toBeUndefined();
    expect(parseCursor('later.id-1')).toBeUndefined();
    expect(parseCursor('1700000000000.')).toBeUndefined();
    expect(parseCursor('1700000000000.id-1')).toStrictEqual({ at: 1_700_000_000_000, id: 'id-1' });
  });
});

describe('the Activity page', () => {
  it('ACT-63 lists the latest calls across computers and flags this week’s unexpected writes', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions, WRITABLE);
    await harness.actions.engine.call(caller(), httpInvocation());
    await harness.actions.engine.call(caller(), httpInvocation({ method: 'POST', body: 'x' }));
    const { browser } = await signedInOperator(harness);
    const markup = await pageMarkup(browser, '/account/activity');
    expect(markup).toContain('<section class="card flush" id="recent-calls">');
    const recent = markup.slice(markup.indexOf('id="recent-calls"'));
    expect(rowsOf(recent)).toHaveLength(2);
    expect(markup).toContain('1 this week');
    expect(markup).toContain('id="audit-export"');
  });

  it('ACT-47 ACT-60 colours a failure red and an accepted confirmation green on a computer’s calls', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, {
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
    });
    const post = httpInvocation({ method: 'POST', body: 'x' });
    const pending = confirmationOf(await harness.actions.engine.call(caller(), post));
    await harness.actions.engine.call(
      caller({
        confirmation: {
          requestState: pending.requestState,
          result: { action: 'accept', content: { confirm: true } },
        },
      }),
      post,
    );
    harness.actions.connector.behaviour.mode = 'fail';
    harness.actions.connector.behaviour.failWith = 'connection_failed';
    await harness.actions.engine.call(caller(), httpInvocation());
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageMarkup(browser, `/account/actions/${target.id}`));
    expect(markup).toContain('<span class="tag tag-green"><svg class="icon"');
    expect(markup).toContain('</svg>accepted</span>');
    expect(markup).toContain('<span class="tag tag-red">error:connection_failed</span>');
  });
});
