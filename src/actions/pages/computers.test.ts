import { describe, expect, it } from 'vitest';

import { html } from '../../identity/pages/template.ts';
import {
  caller,
  CLIENT_ID,
  createHttpTarget,
  httpInvocation,
  OTHER_CLIENT_ID,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { fixtureTargetRow } from '../../test-support/actions-store-fixtures.ts';
import { compact, pageText, statusOf } from '../../test-support/identity-app.ts';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml';

function listOf(markup: string): string {
  const start = markup.indexOf('<table class="computers">');
  return compact(markup.slice(start, markup.indexOf('</table>', start)));
}

function sidebarOf(markup: string): string {
  return compact(
    markup.slice(markup.indexOf('<aside class="sidebar">'), markup.indexOf('</aside>')),
  );
}

describe('the Computers page', () => {
  it('ACT-5 ACT-73 is absent, with every route and its navigation, while the layer is off', async () => {
    const harness = createPagesHarness({ enabled: false });
    const { browser } = await signedInOperator(harness);
    const markup = await pageText(browser, '/account');
    expect(markup).not.toContain('/account/actions');
    expect(sidebarOf(markup)).not.toContain('Add connection');
    const list = await browser.get('/account/actions');
    expect(list.status).toBe(404);
    const create = await browser.get('/account/actions/new?connector=http');
    expect(create.status).toBe(404);
    const write = await browser.submit('/account/actions/id-1/disable', {});
    expect(write.status).toBe(404);
  });

  it('ACT-5 lists every target with its address, the item and fields it signs in with, what it allows, its agents, last call and state', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: undefined },
    );
    await createHttpTarget(harness.actions, { grantTo: [CLIENT_ID, OTHER_CLIENT_ID] });
    await createHttpTarget(harness.actions, {
      name: 'quiet',
      base_url: 'https://quiet.example.com',
      enabled: false,
      grantTo: [],
    });
    await harness.actions.engine.call(caller(), httpInvocation());
    const { browser } = await signedInOperator(harness, false);
    const response = await browser.get('/account/actions');
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(markup).toContain('<h1>Connections</h1>');
    const list = listOf(markup);
    expect(list).toContain('>HTTP APIs <span class="count">2</span');
    expect(list).toContain('<a class="mono strong" href="/account/actions/id-1">api</a');
    expect(list).toContain('<span class="cell-sub clamp">The example API</span>');
    expect(list).toContain('<span class="mono">api.example.com/v1</span');
    expect(list).toContain('<span class="cell-sub">public · encrypted</span>');
    expect(list).toContain('Example Login');
    expect(list).toContain('<span class="sealed"');
    expect(list).toContain('</svg>password</span');
    expect(list).toContain('<span>GET, HEAD</span>');
    expect(list).toContain('Reads only');
    expect(list).toContain('title="Agent One">AO</span>');
    expect(list).toContain('title="vg_c_other">VC</span>');
    expect(list).toContain('<span>just now</span>');
    expect(list).toContain('<span class="tag tag-green">ok</span>');
    expect(list).toContain('<span class="pill pill-ok">Enabled</span>');
    expect(list).toContain('<a class="mono strong" href="/account/actions/id-2">quiet</a');
    expect(list).toContain('<span class="pill pill-off">Disabled</span>');
    expect(list).toContain('<span class="cell-sub">None</span>');
    expect(list).toContain('<span class="cell-sub">No calls yet</span>');
    expect(list).not.toContain('item-login');
    expect(markup).toContain('href="/account/actions/new"');
  });

  it('ACT-5 files targets by kind, with a filter per kind present and the sidebar counting them', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions);
    await createHttpTarget(harness.actions, {
      name: 'directory',
      base_url: 'https://graph.microsoft.com/v1.0',
      mapping: {
        mode: 'graph',
        tenant_id: '11111111-2222-3333-4444-555555555555',
        client_id: '66666666-7777-8888-9999-000000000000',
        grant: 'client_credentials',
        secret_field: 'password',
      },
    });
    const { browser } = await signedInOperator(harness, false);
    const all = await pageText(browser, '/account/actions');
    expect(all).toContain('<a href="/account/actions" aria-current="page"');
    expect(all).toContain('<a href="/account/actions?kind=graph"');
    expect(all).toContain('>Microsoft Graph <span class="count">1</span');
    const sidebar = sidebarOf(all);
    expect(sidebar).toContain('<span class="nav-count">2</span>');
    expect(sidebar).toContain('href="/account/actions?kind=http"');
    expect(sidebar).toContain('<a class="cta" href="/account/actions/new">');
    const graph = await pageText(browser, '/account/actions?kind=graph');
    const list = listOf(graph);
    expect(list).toContain('>directory</a');
    expect(list).not.toContain('>api</a');
    expect(list).not.toContain('class="group-row"');
    const unknown = await pageText(browser, '/account/actions?kind=constructor');
    expect(listOf(unknown)).toContain('>api</a');
  });

  it('ACT-1 ACT-49 puts what needs attention first: an invalid row and a target that writes unconfirmed', async () => {
    const harness = createPagesHarness();
    const { repo } = harness.actions.engine.targets;
    repo.insert(fixtureTargetRow({ id: 'row-1', name: 'broken', policy: {} }));
    await createHttpTarget(harness.actions, {
      name: 'writer',
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: false },
    });
    const { browser } = await signedInOperator(harness, false);
    const markup = await pageText(browser, '/account/actions');
    expect(markup).toContain('<strong>Needs attention</strong>');
    expect(markup).toContain('<span class="mono">broken</span> needs fixing');
    expect(markup).toContain(
      '<span class="mono">writer</span> changes things without a person’s OK',
    );
    expect(listOf(markup)).toContain('<span class="pill pill-bad">Needs fixing</span>');
    expect(listOf(markup)).toContain('Writes are not confirmed');
  });

  it('ACT-5 shows the way to add the first computer when there is none, and names a deletion', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness, false);
    const empty = await pageText(browser, '/account/actions');
    expect(empty).toContain('<strong>No connections yet.</strong>');
    expect(empty).not.toContain('<table class="computers">');
    const deleted = await pageText(browser, '/account/actions?notice=deleted');
    expect(deleted).toContain(
      '<p class="notice">Connection deleted. Its calls stay in the audit trail.</p>',
    );
    const constructor = await pageText(browser, '/account/actions?notice=constructor');
    expect(constructor).not.toContain('class="notice"');
  });

  it('ID-19 serves every page under the unchanged policy, with no script, and renders operator text inert', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, {
      description: 'Sales API <script>alert(1)</script>',
    });
    const { browser } = await signedInOperator(harness);
    const list = await browser.get('/account/actions');
    const policy = list.headers.get('content-security-policy');
    expect(policy).toContain("default-src 'none'");
    const pages = [
      list,
      await browser.get(`/account/actions/${target.id}`),
      await browser.get(`/account/actions/${target.id}/edit`),
      await browser.get('/account/actions/new'),
      await browser.get('/account/actions/new?connector=http'),
    ];
    const markups: string[] = [];
    for (const page of pages) {
      const markup = await page.text();
      markups.push(markup);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toBe(policy);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(markup).not.toContain('<script');
      expect(markup).not.toContain('<style');
      expect(markup).not.toContain(' style="');
    }
    expect(markups[1]).toContain(
      '<p class="intro">Sales API &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(markups[2]).toContain(
      'maxlength="200">\nSales API &lt;script&gt;alert(1)&lt;/script&gt;</textarea>',
    );
  });

  it('ID-22 sends an anonymous browser to login with the return path and answers 404 for an unknown target', async () => {
    const harness = createPagesHarness();
    const anonymous = harness.browser();
    const list = await anonymous.get('/account/actions');
    expect(list.headers.get('location')).toBe('/login?next=%2Faccount%2Factions');
    const create = await anonymous.get('/account/actions/new?connector=http');
    expect(create.status).toBe(303);
    expect(create.headers.get('location')).toBe(
      '/login?next=%2Faccount%2Factions%2Fnew%3Fconnector%3Dhttp',
    );
    const page = await anonymous.get('/account/actions/id-1');
    expect(page.headers.get('location')).toBe('/login?next=%2Faccount%2Factions%2Fid-1');
    const edit = await anonymous.get('/account/actions/id-1/edit');
    expect(edit.headers.get('location')).toBe('/login?next=%2Faccount%2Factions%2Fid-1%2Fedit');
    const { browser } = await signedInOperator(harness, false);
    const missing = await browser.get('/account/actions/nope', { accept: BROWSER_ACCEPT });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Page not found');
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await statusOf(browser, '/account/actions/nope/edit')).toBe(404);
    const laterConnector = await browser.get('/account/actions/new?connector=browser');
    expect(laterConnector.status).toBe(404);
  });

  it('ID-26 ID-21 sends an account with no address yet to set one, and a session whose operator is gone to sign in', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness, false);
    harness.identity.database.exec('UPDATE operators SET email = NULL');
    for (const path of [
      '/account/actions',
      '/account/actions/new',
      '/account/actions/unexpected',
    ]) {
      const response = await browser.get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/account');
    }
    harness.identity.database.exec('PRAGMA foreign_keys = OFF');
    harness.identity.database.exec('DELETE FROM operators');
    harness.identity.database.exec('PRAGMA foreign_keys = ON');
    const gone = await browser.get('/account/actions');
    expect(gone.headers.get('location')).toBe('/login?next=%2Faccount%2Factions');
    const session = {
      idHash: 'stale',
      operatorId: 'gone',
      csrfToken: 'token',
      createdAt: 0,
      expiresAt: 1,
      reauthenticatedAt: undefined,
      isReauthenticated: false,
    };
    const page = { title: 'Stale', active: 'agents', crumbs: [], body: html``, returnTo: '/' };
    const framed = sidebarOf(await harness.identity.identity.renderConsole(session, page));
    expect(framed).toContain('<span class="avatar" aria-hidden="true">?</span>');
    expect(framed).toContain('<span class="operator-email">No e-mail address yet</span>');
  });
});
