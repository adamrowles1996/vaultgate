import { describe, expect, it } from 'vitest';

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
import { createSqlTarget } from '../../test-support/sql-connector.ts';
import { createSshTarget } from '../../test-support/ssh-connector.ts';
import { createWinrmTarget } from '../../test-support/winrm-connector.ts';
import { VaultError } from '../../vault/client.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml';

/**
ACT-49: the note the target page carries once the operator turns the confirmation off.
*/
const UNCONFIRMED_NOTE = 'Confirmation is off: a granted client can change things here';

/**
The stored target's edit form, as posted back unchanged but for `fields`.
*/
function editOf(fields: Record<string, string>): Record<string, string> {
  return {
    description: 'The example API',
    'credential.item_id': 'item-login',
    'destination.base_url': 'https://api.example.com/v1',
    'credential.mode': 'bearer',
    'credential.field': 'password',
    'policy.allowed_methods.GET': 'on',
    'policy.allowed_methods.HEAD': 'on',
    'policy.allowed_paths': '/**',
    'policy.allowed_request_headers': 'accept\ncontent-type\nif-none-match',
    'policy.response_headers': 'content-type\ncontent-length\nlocation\nretry-after',
    'policy.max_body_bytes': '262144',
    'policy.timeout_ms': '30000',
    'policy.max_output_bytes': '262144',
    'policy.rate_limit_per_minute': '60',
    ...fields,
  };
}

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

describe('GET /account/actions/:id', () => {
  it('ACT-4 ACT-5 shows where it points, the vault item and sealed fields it signs in with, its rules, grants and calls', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: undefined },
    );
    const target = await createHttpTarget(harness.actions, { internal: true });
    await harness.actions.engine.call(caller(), httpInvocation());
    await harness.actions.engine.call(caller({ clientId: OTHER_CLIENT_ID }), httpInvocation());
    const markup = compact(await pageMarkup(harness, `/account/actions/${target.id}`));
    expect(markup).toContain('<title>api · vaultgate</title>');
    expect(markup).toContain('<h1 class="mono">api</h1><span class="pill pill-ok">Enabled</span>');
    expect(markup).toContain('<dt>Destination</dt><dd class="mono">api.example.com/v1</dd>');
    expect(markup).toContain('<dt>Network</dt><dd>internal · encrypted</dd>');
    expect(markup).toContain('<dt>Revision</dt><dd>1 · updated just now</dd>');
    expect(markup).toContain('Example Login');
    expect(markup).toContain('<span class="mono cell-sub">item-login</span>');
    expect(markup).toContain('<dt>Secret</dt><dd><span class="sealed"');
    expect(markup).not.toContain('CANARY');
    expect(markup).toContain('<dt>Allows</dt><dd>GET, HEAD</dd>');
    expect(markup).toContain('href="/account/actions/id-1/edit"');
    expect(markup).toContain('action="/account/actions/id-1/disable"');
    expect(markup).toContain('action="/account/actions/id-1/sessions/close"');
    expect(markup).toContain('action="/account/actions/id-1/delete"');
    expect(markup).toContain(
      '<span>Agent One</span><span class="cell-sub">Granted 2026-09-22 12:00 UTC</span>',
    );
    expect(markup).toContain('<input type="hidden" name="client_id" value="vg_c_agent" />');
    expect(markup).toContain('<option value="vg_c_other">vg_c_other</option>');
    expect(markup).not.toContain('<option value="vg_c_agent">');
    expect(markup).toContain(
      '<td data-label="Time">2026-09-22T12:00:00.000Z</td> <td data-label="Agent">Agent One</td>',
    );
    expect(markup).toContain(
      '<td data-label="Operation">read</td> <td data-label="Classification">GET</td>',
    );
    expect(markup).toContain('<span class="tag tag-green">ok</span>');
    expect(markup).toContain('<td data-label="Agent">vg_c_other</td>');
    expect(markup).toContain('<span class="tag tag-amber">denied:not_granted</span>');
    expect(markup).toContain('href="/account/actions/id-1/calls"');
  });

  it('ACT-5 ACT-49 edits on a page of its own, with the policy in force and the name fixed', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions, { internal: true });
    const markup = await pageMarkup(harness, `/account/actions/${target.id}/edit`);
    expect(markup).toContain('<title>Edit api · vaultgate</title>');
    expect(markup).toContain(
      '<form method="post" action="/account/actions/id-1" class="target-form">',
    );
    expect(markup).toContain('name="internal" type="checkbox" checked');
    expect(markup).not.toContain('name="name"');
    expect(markup).toContain('name="destination.base_url" value="https://api.example.com/v1"');
    expect(markup).toContain('name="policy.allowed_methods.GET" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.HEAD" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.POST" type="checkbox"  />');
    expect(markup).toContain('name="policy.timeout_ms"');
    expect(markup).toContain('value="30000"');
    expect(markup).toContain('name="policy.confirm_writes" type="checkbox"  />');
    expect(markup).toContain('<button type="submit" class="primary">Save changes</button>');
  });

  it('ACT-1 ACT-4 ACT-54 shows the stored documents of an invalid row for repair, and the precise vault reason', async () => {
    const harness = createPagesHarness();
    const { repo } = harness.actions.engine.targets;
    repo.insert(
      fixtureTargetRow({
        id: 'row-1',
        name: 'broken',
        credential: { item_id: 'item-nope', mapping: { mode: 'header', name: 'X-Key' } },
        policy: 'nope',
      }),
    );
    repo.insert(
      fixtureTargetRow({ id: 'row-2', name: 'db', connector: 'browser', internal: true }),
    );
    const { browser } = await signedInOperator(harness);
    const brokenMarkup = compact(await pageText(browser, '/account/actions/row-1'));
    expect(brokenMarkup).toContain('target_invalid: credential.mapping.field:');
    expect(brokenMarkup).toContain('no such item in the vault');
    expect(brokenMarkup).toContain('<span class="pill pill-bad">Needs fixing</span>');
    expect(brokenMarkup).toContain('<dd class="mono">not readable</dd>');
    const repair = await pageText(browser, '/account/actions/row-1/edit');
    expect(repair).toContain('<option value="header" selected>header</option>');
    expect(repair).toContain('name="credential.name" value="X-Key"');
    expect(repair).toContain('<textarea name="policy.allowed_paths" rows="4"></textarea>');
    const laterMarkup = await pageText(browser, '/account/actions/row-2');
    expect(laterMarkup).not.toContain('href="/account/actions/row-2/edit"');
    expect(laterMarkup).toContain('action="/account/actions/row-2/delete"');
    expect(await statusOf(browser, '/account/actions/row-2/edit')).toBe(404);
    harness.actions.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const lockedMarkup = await pageText(browser, '/account/actions/row-1');
    expect(lockedMarkup).toContain('the item could not be checked: vault_unavailable');
    const edit = await browser.submit('/account/actions/row-2', { csrf: '' });
    expect(edit.status).toBe(403);
  });

  it('ACT-49 notes a target that changes things without asking, and says nothing where it asks or reads only', async () => {
    const harness = createPagesHarness();
    await createHttpTarget(harness.actions, {
      policy: { allowed_methods: ['GET', 'POST'] },
    });
    await createHttpTarget(harness.actions, {
      name: 'reader',
      base_url: 'https://read.example.com',
      policy: { allowed_methods: ['GET', 'HEAD'] },
    });
    await createHttpTarget(harness.actions, {
      name: 'asks',
      base_url: 'https://asks.example.com',
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
    });
    await createSqlTarget(harness.actions, { name: 'replica' });
    await createSshTarget(harness.actions, { name: 'host' });
    await createWinrmTarget(harness.actions, { name: 'agent' });
    harness.actions.engine.targets.repo.insert(fixtureTargetRow({ id: 'row-1', policy: 'nope' }));
    const { browser } = await signedInOperator(harness);
    const noted: boolean[] = [];
    for (const id of ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'row-1']) {
      const page = await browser.get(`/account/actions/${id}`);
      expect(page.status).toBe(200);
      const markup = await page.text();
      noted.push(markup.includes(UNCONFIRMED_NOTE));
    }
    // api (http write), reader, asks, replica (sql read-only), host (ssh),
    // agent (winrm), the invalid row.
    expect(noted).toStrictEqual([true, false, false, false, true, true, false]);
  });

  it('ID-15 offers no change before the password is confirmed and leads to confirming it and back', async () => {
    const harness = createPagesHarness();
    harness.clients.push({ clientId: CLIENT_ID, clientName: 'Agent One' });
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness, false);
    const markup = compact(await pageText(browser, `/account/actions/${target.id}`));
    expect(markup).toContain('href="/account/unlock?next=%2Faccount%2Factions%2Fid-1"');
    // Check now is the one form, and it changes nothing (ACT-118).
    expect(markup.match(/action="\/account\/actions\/[^"]*"/gu)).toStrictEqual([
      'action="/account/actions/id-1/check"',
    ]);
    expect(markup).not.toContain('id="manage"');
    expect(markup).toContain('<span>Agent One</span>');
    const edit = compact(await pageText(browser, `/account/actions/${target.id}/edit`));
    expect(edit).toContain(
      'Changing a connection needs your password, confirmed in the last five minutes.',
    );
    expect(edit).toContain('href="/account/unlock?next=%2Faccount%2Factions%2Fid-1%2Fedit"');
    expect(edit).not.toContain('action="/account/actions/id-1"');
  });
});

describe('POST /account/actions/:id', () => {
  it('ACT-1 ACT-6 ACT-7 saves an edit, bumps the revision and records the changed field names only', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    harness.actions.audit.length = 0;
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit(
      `/account/actions/${target.id}`,
      editOf({
        csrf,
        description: 'Renamed',
        'credential.mode': 'header',
        'credential.field': 'custom.API key',
        'credential.name': 'X-Api-Key',
        'policy.allowed_methods.POST': 'on',
        'policy.confirm_writes': 'on',
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/actions/id-1?notice=updated');
    expect(harness.actions.engine.targets.get(target.id)).toMatchObject({
      revision: 2,
      description: 'Renamed',
      credential: {
        item_id: 'item-login',
        mapping: { mode: 'header', field: 'custom.API key', name: 'X-Api-Key' },
      },
      policy: { allowed_methods: ['GET', 'HEAD', 'POST'], confirm_writes: true },
      updatedBy: operatorId(harness),
    });
    expect(actionsAudit(harness)).toStrictEqual([
      {
        action: 'target_updated',
        operatorId: operatorId(harness),
        clientId: undefined,
        details: {
          target: 'api',
          connector: 'http',
          changed: ['description', 'credential', 'policy'],
          sessions: 0,
        },
      },
    ]);
    expect(JSON.stringify(harness.actions.audit)).not.toContain('X-Api-Key');
    const page = await browser.get('/account/actions/id-1?notice=updated');
    const markup = compact(await page.text());
    expect(markup).toContain('Connection saved; its revision has moved on');
    expect(markup).toContain('<dt>Revision</dt><dd>2 · updated just now</dd>');
  });

  it('ACT-6 re-renders the edit page with every problem and the submitted values when the edit is rejected', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit(
      `/account/actions/${target.id}`,
      editOf({
        csrf,
        'destination.base_url': 'https://api.example.com/v1?x=1',
        'policy.timeout_ms': '5',
      }),
    );
    const markup = await response.text();
    expect(response.status).toBe(400);
    expect(markup).toContain(
      'The connection was not saved; fix the problems shown against each field',
    );
    expect(markup).toContain(
      '<p class="field-error">must not carry a query string or fragment</p>',
    );
    expect(markup).toContain(
      '<p class="field-error">How long one call may run, in milliseconds: 1000 to 300000. (Too small',
    );
    expect(markup).toContain('name="destination.base_url" value="https://api.example.com/v1?x=1"');
    expect(markup).toContain('value="5"');
    expect(harness.actions.engine.targets.get(target.id)?.revision).toBe(1);
    const missing = await browser.submit('/account/actions/nope', editOf({ csrf }), {
      headers: { accept: BROWSER_ACCEPT },
    });
    expect(missing.status).toBe(404);
  });
});
