import { describe, expect, it } from 'vitest';

import { createHttpTarget, PUBLIC_ADDRESS } from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';

import { checkCard } from './check-report.ts';

/**
A SQL Server computer on the fixture login item, as the form posts it.
*/
const SQL = {
  connector: 'sql',
  name: 'erp',
  description: 'The ERP database',
  'credential.item_id': 'item-login',
  'destination.engine': 'mssql',
  'destination.host': 'db.example.com',
  'destination.port': '1433',
  'destination.database': 'erp',
  'destination.tls': 'require',
  'credential.username_from': 'login.username',
  'credential.password_field': 'password',
  'policy.operations.read': 'on',
  'policy.timeout_ms': '30000',
  intent: 'check',
};

const AT = Date.parse('2026-09-24T12:00:00Z');

describe('checks as you go', () => {
  it('ACT-118 checks a new computer without saving it, and says what each check found', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', { csrf, ...SQL });
    expect(response.status).toBe(200);
    const markup = compact(await response.text());
    expect(markup).toContain('<span class="pill pill-ok">Everything checks out</span>');
    expect(markup).toContain(
      `<span class="mono">db.example.com</span> resolves to <span class="mono">${PUBLIC_ADDRESS}</span> · encrypted`,
    );
    expect(markup).toContain('Vault item <strong>Example Login</strong> is there');
    expect(markup).toContain('<span class="field-chip">login.username</span> is on the item');
    expect(markup).toContain('</svg>password</span> is on the item');
    expect(markup).toContain('Nothing was saved and nothing connected.');
    expect(markup).toContain('value="db.example.com"');
    expect(markup).not.toContain('The computer was not saved');
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
    expect(harness.actions.audit).toStrictEqual([]);
  });

  it('ACT-118 ACT-6 reports every problem at once, beside the fields as a save would', async () => {
    const harness = createPagesHarness({ addresses: { 'db.example.com': ['10.0.0.8'] } });
    await createHttpTarget(harness.actions, { name: 'erp' });
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      ...SQL,
      'credential.password_field': 'custom.nope',
      address_from: 'not a host!',
    });
    expect(response.status).toBe(200);
    const markup = compact(await response.text());
    expect(markup).toContain('<span class="pill pill-bad">4 problems</span>');
    expect(markup).toContain('<span class="mono">db.example.com</span> is refused');
    expect(markup).toContain('the item has no &quot;custom.nope&quot; field');
    expect(markup).toContain('name: a target of that name already exists');
    expect(markup).toContain('the vault item&#39;s address &quot;not a host!&quot; names no host');
    expect(markup).toContain('<p class="field-error">a target of that name already exists');
    expect(harness.actions.engine.targets.list()).toHaveLength(1);
  });

  it('ACT-118 stops where a save would, at a name the rules refuse, and says so', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', { csrf, ...SQL, name: 'Bad Name' });
    const markup = compact(await response.text());
    expect(markup).toContain('<span class="pill pill-bad">1 problem</span>');
    expect(markup).toContain('name: must be 1 to 63 lower-case letters, digits or hyphens');
    expect(markup).not.toContain('resolves to');
  });

  it('ACT-118 checks an edit without saving it, and a saved computer from its page', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser, csrf } = await signedInOperator(harness);
    const edit = await browser.submit(`/account/actions/${target.id}`, {
      csrf,
      intent: 'check',
      description: 'Changed',
      'credential.item_id': 'item-login',
      'destination.base_url': 'https://api.example.com/v1',
      'credential.mode': 'bearer',
      'credential.field': 'password',
      'policy.allowed_methods.GET': 'on',
      'policy.allowed_paths': '/v1/**',
      'policy.timeout_ms': '30000',
    });
    expect(edit.status).toBe(200);
    expect(compact(await edit.text())).toContain('Everything checks out');
    expect(harness.actions.engine.targets.get(target.id)).toMatchObject({
      description: target.description,
      revision: 1,
    });
    const page = compact(await pageText(browser, `/account/actions/${target.id}`));
    expect(page).toContain(`href="/account/actions/${target.id}?check=now"`);
    expect(page).not.toContain('id="check"');
    const checked = compact(await pageText(browser, `/account/actions/${target.id}?check=now`));
    expect(checked).toContain('<section class="card" id="check">');
    expect(checked).toContain(
      '<span class="mono">api.example.com</span> resolves to <span class="mono">',
    );
  });

  it('ACT-118 ID-15 checks a saved computer outside the password window, but a form only inside it', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser, csrf } = await signedInOperator(harness, false);
    const checked = compact(await pageText(browser, `/account/actions/${target.id}?check=now`));
    expect(checked).toContain('Everything checks out');
    const form = await browser.submit('/account/actions', { csrf, ...SQL });
    expect(form.status).toBe(403);
  });

  it('ACT-118 draws plain transport, a missing item and a check that stopped at the shape', () => {
    const plain = compact(
      checkCard({
        at: AT,
        report: {
          problems: ['destination: plain transport to "h" needs internal: true'],
          endpoints: [
            {
              host: 'h',
              tls: false,
              address: '10.0.0.8',
              problems: ['destination: plain transport to "h" needs internal: true'],
            },
          ],
          credential: {
            item: { found: false, problem: 'credential.item_id: no such item in the vault' },
            fields: [],
          },
          rules: [],
        },
      }).markup,
    );
    expect(plain).toContain('<span class="pill pill-bad">1 problem</span>');
    expect(plain).toContain('· plain transport');
    expect(plain).toContain('plain transport to &quot;h&quot; needs internal: true');
    expect(plain).toContain('no such item in the vault');
    expect(plain).toContain('Run 2026-09-24 12:00 UTC.');
    const stopped = compact(
      checkCard({
        at: AT,
        report: { problems: ['name: Required'], endpoints: [], rules: ['name: Required'] },
      }).markup,
    );
    expect(stopped).toContain('name: Required');
    expect(stopped).not.toContain('Vault item');
  });
});
