import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all } from '../../storage/query.ts';
import {
  caller,
  CLIENT_ID,
  createHttpTarget,
  httpInvocation,
  OTHER_CLIENT_ID,
  storedCalls,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import {
  grantRows,
  insertCallRow,
  openSession,
  sessionRows,
} from '../../test-support/actions-store-fixtures.ts';
import { makeLegacy } from '../../test-support/identity-app.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

function operatorId(harness: PagesHarness): string {
  return harness.identity.stores.operators.findAny()?.id ?? '';
}

function actionsAudit(harness: PagesHarness) {
  return harness.actions.audit.map((event) => ({
    action: event.action,
    operatorId: event.operatorId,
    clientId: event.clientId,
    details: event.details,
  }));
}

async function pageMarkup(harness: PagesHarness, path: string): Promise<string> {
  const { browser } = await signedInOperator(harness);
  const page = await browser.get(path);
  return page.text();
}

describe('the one-button writes', () => {
  it('ACT-5 ACT-7 disables and enables a target with its event and notice', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness);
    const disabled = await browser.submit(`/account/actions/${target.id}/disable`, { csrf });
    expect(disabled.headers.get('location')).toBe('/account/actions/id-1?notice=disabled');
    const page = await browser.get('/account/actions/id-1?notice=disabled');
    const markup = await page.text();
    expect(markup).toContain('Target disabled; agents no longer see it.');
    expect(markup).toContain('data-label="Setting">Enabled</td> <td data-label="Value">no</td>');
    expect(markup).toContain('action="/account/actions/id-1/enable"');
    const enabled = await browser.submit(`/account/actions/${target.id}/enable`, { csrf });
    expect(enabled.headers.get('location')).toBe('/account/actions/id-1?notice=enabled');
    expect(harness.actions.engine.targets.get(target.id)).toMatchObject({
      enabled: true,
      revision: 3,
    });
    expect(actionsAudit(harness).map((event) => event.action)).toStrictEqual([
      'target_disabled',
      'target_enabled',
    ]);
    expect(actionsAudit(harness)[0]?.operatorId).toBe(operatorId(harness));
  });

  it('ACT-8 deletes a target with its grants and sessions, keeps its calls and returns to the account page', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    openSession(harness.actions.database, 'session-1', target.id, CLIENT_ID);
    await harness.actions.engine.call(caller(), httpInvocation());
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit(`/account/actions/${target.id}/delete`, { csrf });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account#actions');
    expect(harness.actions.engine.targets.get(target.id)).toBeUndefined();
    expect(grantRows(harness.actions.database, target.id)).toStrictEqual([]);
    expect(sessionRows(harness.actions.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'target_changed' },
    ]);
    expect(storedCalls(harness.actions.database).map((call) => call.targetName)).toStrictEqual([
      'api',
    ]);
    expect(actionsAudit(harness)).toStrictEqual([
      {
        action: 'target_deleted',
        operatorId: operatorId(harness),
        clientId: undefined,
        details: { target: 'api', connector: 'http', sessions: 1 },
      },
    ]);
    const account = await browser.get('/account');
    const markup = await account.text();
    expect(markup).toContain('No targets are defined.');
    const again = await browser.submit(`/account/actions/${target.id}/delete`, { csrf });
    expect(again.status).toBe(404);
  });

  it('ACT-7 ACT-9 adds and removes grants among the clients holding a consent, refusing an unknown client', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: 'Agent Two' },
    );
    const target = await createHttpTarget(harness.actions, { grantTo: [] });
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness);
    const granted = await browser.submit(`/account/actions/${target.id}/grants`, {
      csrf,
      client_id: OTHER_CLIENT_ID,
    });
    expect(granted.headers.get('location')).toBe('/account/actions/id-1?notice=granted');
    const page = await browser.get('/account/actions/id-1?notice=granted');
    const markup = await page.text();
    expect(markup).toContain('<p class="notice">Grant added.</p>');
    expect(markup).toContain('data-label="Client">Agent Two</td>');
    expect(markup).toContain('<option value="vg_c_agent">Agent One</option>');
    expect(markup).not.toContain('<option value="vg_c_other">');
    openSession(harness.actions.database, 'session-1', target.id, OTHER_CLIENT_ID);
    const revoked = await browser.submit(`/account/actions/${target.id}/grants/revoke`, {
      csrf,
      client_id: OTHER_CLIENT_ID,
    });
    expect(revoked.headers.get('location')).toBe('/account/actions/id-1?notice=grant-revoked');
    expect(grantRows(harness.actions.database, target.id)).toStrictEqual([
      { client_id: OTHER_CLIENT_ID, revoked_at: harness.identity.now() },
    ]);
    expect(sessionRows(harness.actions.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'revoked' },
    ]);
    const stranger = await browser.submit(`/account/actions/${target.id}/grants`, { csrf });
    const strangerMarkup = await stranger.text();
    expect(stranger.status).toBe(400);
    expect(strangerMarkup).toContain('<p class="error" role="alert">client_id: no such client</p>');
    expect(actionsAudit(harness)).toStrictEqual([
      {
        action: 'grant_added',
        operatorId: operatorId(harness),
        clientId: OTHER_CLIENT_ID,
        details: { target: 'api', connector: 'http' },
      },
      {
        action: 'grant_removed',
        operatorId: operatorId(harness),
        clientId: OTHER_CLIENT_ID,
        details: { target: 'api', connector: 'http', sessions: 1 },
      },
    ]);
    const unnamed = await browser.submit(`/account/actions/${target.id}/grants/revoke`, { csrf });
    expect(unnamed.headers.get('location')).toBe('/account/actions/id-1?notice=grant-revoked');
    const cleared = await browser.get('/account/actions/id-1');
    const clearedMarkup = await cleared.text();
    expect(clearedMarkup).toContain('No client is granted this target.');
    harness.clients.length = 0;
    const nobody = await browser.get('/account/actions/id-1');
    const nobodyMarkup = await nobody.text();
    expect(nobodyMarkup).toContain(
      'Every connected client already holds a grant, or none is connected.',
    );
  });

  it('ACT-5 ACT-7 closes every open session of the target as the operator and records how many', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    openSession(harness.actions.database, 'session-1', target.id, CLIENT_ID);
    openSession(harness.actions.database, 'session-2', target.id, OTHER_CLIENT_ID);
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness);
    const before = await browser.get(`/account/actions/${target.id}`);
    const beforeMarkup = await before.text();
    expect(beforeMarkup).toContain(
      'data-label="Setting">Open sessions</td> <td data-label="Value">2</td>',
    );
    const closed = await browser.submit(`/account/actions/${target.id}/sessions/close`, { csrf });
    expect(closed.headers.get('location')).toBe('/account/actions/id-1?notice=sessions-closed');
    expect(sessionRows(harness.actions.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'operator' },
      { id_hash: 'session-2', close_reason: 'operator' },
    ]);
    expect(actionsAudit(harness)).toStrictEqual([
      {
        action: 'sessions_closed',
        operatorId: operatorId(harness),
        clientId: undefined,
        details: { target: 'api', connector: 'http', sessions: 2 },
      },
    ]);
    const after = await browser.get('/account/actions/id-1?notice=sessions-closed');
    const afterMarkup = await after.text();
    expect(afterMarkup).toContain('Every open session on this target was closed.');
    expect(afterMarkup).toContain(
      'data-label="Setting">Open sessions</td> <td data-label="Value">0</td>',
    );
  });

  it('ID-15 ID-18 refuses every write without re-authentication, without the ID-18 checks and in legacy mode', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness, false);
    const paths = [
      '/account/actions',
      `/account/actions/${target.id}`,
      `/account/actions/${target.id}/enable`,
      `/account/actions/${target.id}/disable`,
      `/account/actions/${target.id}/delete`,
      `/account/actions/${target.id}/grants`,
      `/account/actions/${target.id}/grants/revoke`,
      `/account/actions/${target.id}/sessions/close`,
    ];
    for (const path of paths) {
      const unconfirmed = await browser.submit(path, { csrf });
      expect(unconfirmed.status).toBe(403);
      const crossSite = await browser.submit(path, { csrf }, { origin: false });
      expect(crossSite.status).toBe(403);
      const staleToken = await browser.submit(path, { csrf: 'stale' });
      expect(staleToken.status).toBe(403);
    }
    expect(
      harness.identity.audits.filter((event) => event.action === 'request.denied'),
    ).toHaveLength(paths.length * 3);
    makeLegacy(harness.identity);
    const legacy = await browser.submit(paths[2] ?? '', { csrf });
    expect(legacy.status).toBe(403);
    expect(harness.identity.audits.at(-1)?.details).toStrictEqual({
      reason: 'e-mail address required',
      path: paths[2],
    });
    expect(harness.actions.audit).toStrictEqual([]);
    expect(harness.actions.engine.targets.get(target.id)?.revision).toBe(1);
  });
});

describe('call history', () => {
  it('ACT-63 shows the last 50 calls of the target newest first, and only that target’s', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const other = await createHttpTarget(harness.actions, {
      name: 'other',
      base_url: 'https://o.example.com',
    });
    for (let index = 1; index <= 51; index += 1) {
      insertCallRow(harness.actions.database, {
        id: `call-${String(index).padStart(2, '0')}`,
        at: 1000 + index,
        targetId: target.id,
        outcome: index === 51 ? 'denied:policy_denied' : 'ok',
      });
    }
    insertCallRow(harness.actions.database, {
      id: 'call-other',
      at: 9000,
      targetId: other.id,
      targetName: 'other',
    });
    const markup = await pageMarkup(harness, `/account/actions/${target.id}`);
    const times = Array.from(markup.matchAll(/data-label="Time">([^<]+)</g), (match) => match[1]);
    expect(times).toHaveLength(50);
    expect(times[0]).toBe(new Date(1051).toISOString());
    expect(times.at(-1)).toBe(new Date(1002).toISOString());
    expect(markup).toContain('data-label="Outcome">denied:policy_denied</td>');
    expect(markup).not.toContain(new Date(9000).toISOString());
    const countRow = z.object({ n: z.number() });
    const kept = all(harness.actions.database, 'SELECT COUNT(*) AS n FROM action_calls', countRow);
    expect(kept).toStrictEqual([{ n: 52 }]);
  });
});
