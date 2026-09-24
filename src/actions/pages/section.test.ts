import { describe, expect, it } from 'vitest';

import {
  caller,
  CLIENT_ID,
  createHttpTarget,
  httpInvocation,
  OTHER_CLIENT_ID,
} from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { fixtureTargetRow, openSession } from '../../test-support/actions-store-fixtures.ts';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml';

function sectionOf(markup: string): string {
  const start = markup.indexOf('<section id="actions">');
  return markup.slice(start, markup.indexOf('</section>', start));
}

describe('the account page Actions section', () => {
  it('ACT-5 ACT-73 is absent, with every route, while the layer is off', async () => {
    const harness = createPagesHarness({ enabled: false });
    const { browser } = await signedInOperator(harness);
    const account = await browser.get('/account');
    const markup = await account.text();
    expect(markup).not.toContain('id="actions"');
    expect(markup).not.toContain('/account/actions');
    const create = await browser.get('/account/actions/new?connector=http');
    expect(create.status).toBe(404);
    const write = await browser.submit('/account/actions/id-1/disable', {});
    expect(write.status).toBe(404);
  });

  it('ACT-5 lists every target with its connector, destination summary, state, grants, last call and open sessions, and links to create one', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: undefined },
    );
    const target = await createHttpTarget(harness.actions, {
      grantTo: [CLIENT_ID, OTHER_CLIENT_ID],
    });
    await createHttpTarget(harness.actions, {
      name: 'quiet',
      base_url: 'https://quiet.example.com',
      enabled: false,
      grantTo: [],
    });
    openSession(harness.actions.database, 'session-1', target.id, CLIENT_ID);
    await harness.actions.engine.call(caller(), httpInvocation());
    const { browser } = await signedInOperator(harness, false);
    const account = await browser.get('/account');
    const markup = await account.text();
    const section = sectionOf(markup);
    expect(section).toContain('<a href="/account/actions/id-1">api</a>');
    expect(section).toContain('data-label="Connector">http<');
    expect(section).toContain('data-label="Destination">api.example.com/v1<');
    expect(section).toContain('data-label="Enabled">yes<');
    expect(section).toContain('data-label="Grants">Agent One, vg_c_other<');
    expect(section).toContain('data-label="Last call">2026-09-22T12:00:00.000Z (ok)<');
    expect(section).toContain('data-label="Sessions">1<');
    expect(section).toContain('<a href="/account/actions/id-2">quiet</a>');
    expect(section).toContain('data-label="Enabled">no<');
    expect(section).toContain('data-label="Grants">none<');
    expect(section).toContain('data-label="Last call">never<');
    expect(section).toContain(
      '<a href="/account/actions/new?connector=http">Create an http target</a>',
    );
    // The rows never name a credential field, a vault item or a pattern.
    const rows = section.slice(section.indexOf('<tbody>'), section.indexOf('</tbody>'));
    expect(rows).not.toContain('password');
    expect(rows).not.toContain('item-login');
    expect(rows).not.toContain('/**');
    expect(markup.indexOf('id="actions"')).toBeGreaterThan(markup.indexOf('id="vault"'));
  });

  it('ACT-1 marks a stored row that fails its schema with the problem, and a connector this build cannot validate', async () => {
    const harness = createPagesHarness();
    const { repo } = harness.actions.engine.targets;
    repo.insert(fixtureTargetRow({ id: 'row-1', name: 'broken', policy: {} }));
    repo.insert(fixtureTargetRow({ id: 'row-2', name: 'db', connector: 'browser' }));
    const { browser } = await signedInOperator(harness, false);
    const account = await browser.get('/account');
    const section = sectionOf(await account.text());
    expect(section).toContain(
      '<a href="/account/actions/row-1">broken</a><br /><code>target_invalid</code>: policy.allowed_paths: Invalid input: expected array, received undefined',
    );
    expect(section).toContain(
      '<a href="/account/actions/row-2">db</a><br /><code>target_invalid</code>: connector: browser is not available in this build',
    );
    expect(section).toContain('data-label="Destination"></td>');
  });

  it('ID-19 serves every page under the unchanged policy, with no script, and renders operator text inert', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, {
      description: 'Sales API <script>alert(1)</script>',
    });
    const { browser } = await signedInOperator(harness);
    const account = await browser.get('/account');
    const policy = account.headers.get('content-security-policy');
    expect(policy).toContain("default-src 'none'");
    const pages = [
      account,
      await browser.get(`/account/actions/${target.id}`),
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
    }
    const targetPage = markups[1];
    expect(targetPage).toContain('<p>Sales API &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(targetPage).toContain(
      'maxlength="200">\nSales API &lt;script&gt;alert(1)&lt;/script&gt;</textarea>',
    );
  });

  it('ID-22 sends an anonymous browser to login with the return path and answers 404 for an unknown target', async () => {
    const harness = createPagesHarness();
    const anonymous = harness.browser();
    const create = await anonymous.get('/account/actions/new?connector=http');
    expect(create.status).toBe(303);
    expect(create.headers.get('location')).toBe(
      '/login?next=%2Faccount%2Factions%2Fnew%3Fconnector%3Dhttp',
    );
    const page = await anonymous.get('/account/actions/id-1');
    expect(page.headers.get('location')).toBe('/login?next=%2Faccount%2Factions%2Fid-1');
    const { browser } = await signedInOperator(harness, false);
    const missing = await browser.get('/account/actions/nope', { accept: BROWSER_ACCEPT });
    const markup = await missing.text();
    expect(missing.status).toBe(404);
    expect(markup).toContain('Page not found');
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");
    const noConnector = await browser.get('/account/actions/new');
    expect(noConnector.status).toBe(404);
    const laterConnector = await browser.get('/account/actions/new?connector=browser');
    expect(laterConnector.status).toBe(404);
  });
});
