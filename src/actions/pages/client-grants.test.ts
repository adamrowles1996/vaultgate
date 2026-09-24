import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID,
  createHttpTarget,
  OTHER_CLIENT_ID,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';

import { createClientTargets } from './client-grants.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const CONFIRMED = { csrfToken: 'csrf', isReauthenticated: true };
const UNCONFIRMED = { csrfToken: 'csrf', isReauthenticated: false };

function render(harness: PagesHarness, clientId: string, view = CONFIRMED): string {
  return createClientTargets({ targets: harness.actions.engine.targets })(clientId, view).markup;
}

function auditOf(harness: PagesHarness) {
  return harness.actions.audit
    .filter((event) => event.action === 'grant_added' || event.action === 'grant_removed')
    .map((event) => ({ action: event.action, clientId: event.clientId }));
}

describe('the targets cell of the connected-clients list', () => {
  it('ACT-9 shows the targets a client is granted with a Remove form, and offers the rest', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions);
    await createHttpTarget(harness.actions, {
      name: 'other',
      base_url: 'https://other.example.com',
      grantTo: [],
    });
    const markup = render(harness, CLIENT_ID);
    expect(markup).toContain('<code>api</code> (http)');
    expect(markup).toContain(
      `<form method="post" action="/account/actions/clients/${CLIENT_ID}/grants/revoke">`,
    );
    expect(markup).toContain('<input type="hidden" name="target_id" value="id-1" />');
    expect(markup).toContain(
      `<form method="post" action="/account/actions/clients/${CLIENT_ID}/grants">`,
    );
    expect(markup).toContain('<option value="id-2">other</option>');
    expect(markup).not.toContain('<option value="id-1">');
  });

  it('ACT-9 says so for a client with no grant and offers nothing at all until the password is confirmed', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions);
    expect(render(harness, OTHER_CLIENT_ID)).toContain('<p>No target.</p>');
    const unconfirmed = render(harness, CLIENT_ID, UNCONFIRMED);
    expect(unconfirmed).toContain('<code>api</code> (http)');
    expect(unconfirmed).not.toContain('<form');
    expect(render(harness, CLIENT_ID)).not.toContain('<select');
  });
});

describe('POST /account/actions/clients/:clientId/grants', () => {
  it('ACT-9 grants and revokes from the client’s side and records the same ACT-7 events', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, { grantTo: [] });
    const { browser, csrf } = await signedInOperator(harness);
    const granted = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants`, {
      csrf,
      target_id: target.id,
    });
    expect(granted.status).toBe(303);
    expect(granted.headers.get('location')).toBe(`/account/actions/${target.id}?notice=granted`);
    expect(render(harness, CLIENT_ID)).toContain('<code>api</code>');
    const revoked = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants/revoke`, {
      csrf,
      target_id: target.id,
    });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe(
      `/account/actions/${target.id}?notice=grant-revoked`,
    );
    expect(render(harness, CLIENT_ID)).toContain('<p>No target.</p>');
    expect(auditOf(harness)).toStrictEqual([
      { action: 'grant_added', clientId: CLIENT_ID },
      { action: 'grant_removed', clientId: CLIENT_ID },
    ]);
  });

  it('ACT-9 answers 404 for a target the form does not name and shows the reason for a client that is gone', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, { grantTo: [] });
    const { browser, csrf } = await signedInOperator(harness);
    const missing = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants`, {
      csrf,
      target_id: 'nope',
    });
    expect(missing.status).toBe(404);
    const unnamed = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants`, { csrf });
    expect(unnamed.status).toBe(404);
    const stranger = await browser.submit('/account/actions/clients/vg_c_gone/grants', {
      csrf,
      target_id: target.id,
    });
    expect(stranger.status).toBe(400);
    expect(await stranger.text()).toContain(
      '<p class="error" role="alert">client_id: no such client</p>',
    );
    expect(auditOf(harness)).toStrictEqual([]);
  });

  it('ID-15 refuses a grant written from the client list outside the re-authentication window', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, { grantTo: [] });
    const { browser, csrf } = await signedInOperator(harness, false);
    const refused = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants`, {
      csrf,
      target_id: target.id,
    });
    expect(refused.status).toBe(403);
    expect(auditOf(harness)).toStrictEqual([]);
  });
});
