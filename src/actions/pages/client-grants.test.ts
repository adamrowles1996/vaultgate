import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID,
  createHttpTarget,
  OTHER_CLIENT_ID,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact, pageText, PASSWORD } from '../../test-support/identity-app.ts';

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

describe('the computers row of an agent’s card', () => {
  it('ACT-9 lists the computers an agent is granted, each a link to the computer', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions);
    await createHttpTarget(harness.actions, {
      name: 'other',
      base_url: 'https://other.example.com',
      grantTo: [],
    });
    const markup = compact(render(harness, CLIENT_ID));
    expect(markup).toContain('<a class="tag mono" href="/account/actions/id-1">api</a>');
    expect(markup).not.toContain('other');
    expect(markup).not.toContain('<form');
  });

  it('ACT-9 says so for an agent with no grant, whether or not the password is confirmed', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions);
    expect(render(harness, OTHER_CLIENT_ID)).toContain('<p class="card-note">No computer yet.</p>');
    expect(render(harness, CLIENT_ID, UNCONFIRMED)).toContain('>api</a>');
  });
});

describe('the Agents page’s matrix of grants', () => {
  it('ACT-9 ID-15 draws who may use what, and turns each square into a grant or removal once the password is confirmed', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: undefined },
    );
    await createHttpTarget(harness.actions);
    const locked = await signedInOperator(harness, false);
    const before = compact(await pageText(locked.browser, '/account/agents'));
    expect(before).toContain('<section class="card flush" id="access">');
    expect(before).toContain('<td data-label="Agent One"><span class="square is-granted"');
    expect(before).toContain('<span class="visually-hidden">Granted</span>');
    expect(before).toContain('<span class="visually-hidden">Not granted</span>');
    expect(before).not.toContain('action="/account/actions/clients/');
    await locked.browser.submit('/account/reauthenticate', {
      csrf: locked.csrf,
      password: PASSWORD,
    });
    const markup = compact(await pageText(locked.browser, '/account/agents'));
    expect(markup).toContain(`action="/account/actions/clients/${CLIENT_ID}/grants/revoke"`);
    expect(markup).toContain(`action="/account/actions/clients/${OTHER_CLIENT_ID}/grants"`);
    expect(markup).toContain('<input type="hidden" name="return_to" value="agents" />');
    expect(markup).toContain('aria-label="Remove api from Agent One"');
    expect(markup).toContain('aria-label="Grant api to vg_c_other"');
  });

  it('ACT-9 says what is missing when there is no computer or no connected agent yet', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const markup = await pageText(browser, '/account/agents');
    expect(markup).toContain('Grants appear here once there is a computer and a connected agent.');
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
    expect(render(harness, CLIENT_ID)).toContain('>api</a>');
    const revoked = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants/revoke`, {
      csrf,
      target_id: target.id,
    });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe(
      `/account/actions/${target.id}?notice=grant-revoked`,
    );
    expect(render(harness, CLIENT_ID)).toContain('No computer yet.');
    const fromMatrix = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants`, {
      csrf,
      target_id: target.id,
      return_to: 'agents',
    });
    expect(fromMatrix.headers.get('location')).toBe('/account/agents?notice=granted#access');
    const elsewhere = await browser.submit(`/account/actions/clients/${CLIENT_ID}/grants/revoke`, {
      csrf,
      target_id: target.id,
      return_to: 'https://attacker.example',
    });
    expect(elsewhere.headers.get('location')).toBe(
      `/account/actions/${target.id}?notice=grant-revoked`,
    );
    expect(auditOf(harness)).toStrictEqual([
      { action: 'grant_added', clientId: CLIENT_ID },
      { action: 'grant_removed', clientId: CLIENT_ID },
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
