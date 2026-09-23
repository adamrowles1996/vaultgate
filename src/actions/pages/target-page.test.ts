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
import { VaultError } from '../../vault/client.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml';

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
  it('ACT-4 ACT-5 shows the status with the vault item name, the edit form with the policy in force, the grants and the calls', async () => {
    const harness = createPagesHarness();
    harness.clients.push(
      { clientId: CLIENT_ID, clientName: 'Agent One' },
      { clientId: OTHER_CLIENT_ID, clientName: undefined },
    );
    const target = await createHttpTarget(harness.actions, { internal: true });
    await harness.actions.engine.call(caller(), httpInvocation());
    await harness.actions.engine.call(caller({ clientId: OTHER_CLIENT_ID }), httpInvocation());
    const markup = await pageMarkup(harness, `/account/actions/${target.id}`);
    expect(markup).toContain('<title>Target api · vaultgate</title>');
    expect(markup).toContain('name="internal" type="checkbox" checked');
    expect(markup).toContain('data-label="Value">item-login (Example Login)</td>');
    expect(markup).toContain('data-label="Setting">State</td> <td data-label="Value">valid</td>');
    expect(markup).toContain('data-label="Setting">Revision</td> <td data-label="Value">1</td>');
    expect(markup).toContain('<form method="post" action="/account/actions/id-1">');
    expect(markup).not.toContain('name="name"');
    expect(markup).toContain('name="destination.base_url" value="https://api.example.com/v1"');
    expect(markup).toContain('name="policy.allowed_methods.GET" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.HEAD" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.POST" type="checkbox"  />');
    expect(markup).toContain('name="policy.timeout_ms"');
    expect(markup).toContain('value="30000"');
    expect(markup).toContain('name="policy.confirm_writes" type="checkbox"  />');
    expect(markup).toContain('action="/account/actions/id-1/disable"');
    expect(markup).toContain('action="/account/actions/id-1/sessions/close"');
    expect(markup).toContain('action="/account/actions/id-1/delete"');
    expect(markup).toContain('data-label="Client">Agent One</td>');
    expect(markup).toContain('<input type="hidden" name="client_id" value="vg_c_agent" />');
    expect(markup).toContain('<option value="vg_c_other">vg_c_other</option>');
    expect(markup).not.toContain('<option value="vg_c_agent">');
    expect(markup).toContain(
      '<td data-label="Time">2026-09-22T12:00:00.000Z</td> <td data-label="Tool">http_request</td>',
    );
    expect(markup).toContain(
      'data-label="Operation">read</td> <td data-label="Classification">GET</td>',
    );
    expect(markup).toContain(
      'data-label="Outcome">ok</td> <td data-label="Elicitation">not_required</td>',
    );
    expect(markup).toContain('data-label="Client">vg_c_agent</td>');
    expect(markup).toContain('data-label="Operation"></td> <td data-label="Classification"></td>');
    expect(markup).toContain('data-label="Outcome">denied:not_granted</td>');
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
    repo.insert(fixtureTargetRow({ id: 'row-2', name: 'db', connector: 'winrm', internal: true }));
    const { browser } = await signedInOperator(harness);
    const broken = await browser.get('/account/actions/row-1');
    const brokenMarkup = await broken.text();
    expect(brokenMarkup).toContain('<code>target_invalid</code>: credential.mapping.field:');
    expect(brokenMarkup).toContain('data-label="Value">item-nope (no such item in the vault)</td>');
    expect(brokenMarkup).toContain('<option value="header" selected>header</option>');
    expect(brokenMarkup).toContain('name="credential.name" value="X-Key"');
    expect(brokenMarkup).toContain('<textarea name="policy.allowed_paths" rows="4"></textarea>');
    expect(brokenMarkup).toContain(
      'data-label="Setting">Destination</td> <td data-label="Value">not readable</td>',
    );
    const later = await browser.get('/account/actions/row-2');
    const laterMarkup = await later.text();
    expect(laterMarkup).toContain('This build cannot edit winrm targets yet.');
    expect(laterMarkup).not.toContain('action="/account/actions/row-2"');
    expect(laterMarkup).toContain('action="/account/actions/row-2/delete"');
    harness.actions.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const locked = await browser.get('/account/actions/row-1');
    const lockedMarkup = await locked.text();
    expect(lockedMarkup).toContain('(the item could not be checked: vault_unavailable)');
    const edit = await browser.submit('/account/actions/row-2', { csrf: '' });
    expect(edit.status).toBe(403);
  });

  it('ID-15 offers no form before the password is confirmed and points at the confirmation', async () => {
    const harness = createPagesHarness();
    harness.clients.push({ clientId: CLIENT_ID, clientName: 'Agent One' });
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness, false);
    const page = await browser.get(`/account/actions/${target.id}`);
    const markup = await page.text();
    expect(markup).toContain('<a href="/account#sensitive-actions">confirm your password</a>');
    expect(markup).not.toContain('<form');
    expect(markup).toContain('data-label="Client">Agent One</td>');
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
    const markup = await page.text();
    expect(markup).toContain('Target saved; its revision has moved on');
    expect(markup).toContain('data-label="Setting">Revision</td> <td data-label="Value">2</td>');
  });

  it('ACT-6 re-renders the page with every problem and the submitted values when the edit is rejected', async () => {
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
      '<li>destination.base_url: must not carry a query string or fragment</li>',
    );
    expect(markup).toContain('<li>policy.timeout_ms: Too small');
    expect(markup).toContain('name="destination.base_url" value="https://api.example.com/v1?x=1"');
    expect(markup).toContain('value="5"');
    expect(harness.actions.engine.targets.get(target.id)?.revision).toBe(1);
    const missing = await browser.submit('/account/actions/nope', editOf({ csrf }), {
      headers: { accept: BROWSER_ACCEPT },
    });
    expect(missing.status).toBe(404);
  });
});
