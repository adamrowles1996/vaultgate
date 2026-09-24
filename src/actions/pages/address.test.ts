import { describe, expect, it } from 'vitest';

import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';
import { createSqlTarget } from '../../test-support/sql-connector.ts';

const NEW_SQL = '/account/actions/new?connector=sql&kind=mssql&item=item-login';
const APP_URL = 'https://app.example.com/login';

/**
The fields of a SQL Server computer on the fixture login item, as the form posts them.
*/
const SQL = {
  connector: 'sql',
  name: 'erp',
  description: 'The ERP database',
  'credential.item_id': 'item-login',
  'destination.engine': 'mssql',
  'destination.port': '1433',
  'destination.database': 'erp',
  'destination.tls': 'require',
  'credential.username_from': 'login.username',
  'credential.password_field': 'password',
  'policy.operations.read': 'on',
  'policy.timeout_ms': '30000',
};

describe('the address from the vault item', () => {
  it('ACT-2 offers the item’s addresses beside the address field, the first chosen for a new computer with none typed', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const sql = compact(await pageText(browser, NEW_SQL));
    expect(sql).toContain('<select name="address_from">');
    expect(sql).toMatch(/<input name="destination\.host" value="" autocomplete="off"\s*\/>/u);
    expect(sql).toContain('<option value="" >No: use what is typed above</option>');
    expect(sql).toContain(`<option value="${APP_URL}" selected>${APP_URL} · address 1</option>`);
    expect(sql).toContain('<option value="production" >production · field Environment</option>');
    const http = compact(
      await pageText(browser, '/account/actions/new?connector=http&kind=http&item=item-login'),
    );
    expect(http).toContain(`<option value="${APP_URL}" selected>`);
    expect(http).not.toContain('field Environment');
    const graph = compact(
      await pageText(browser, '/account/actions/new?connector=http&kind=graph&item=item-login'),
    );
    expect(graph).toContain('<option value="" selected>No: use what is typed above</option>');
    const none = compact(
      await pageText(browser, '/account/actions/new?connector=ssh&kind=ssh&item=item-ssh'),
    );
    expect(none).not.toContain('name="address_from"');
    expect(none).toMatch(
      /<input name="destination\.host" value="" autocomplete="off"\s*required\s*\/>/u,
    );
  });

  it('ACT-2 ACT-3 copies the chosen address in when the computer is saved, so the saved address is the one checked', async () => {
    const harness = createPagesHarness({ addresses: { 'app.example.com': ['93.184.216.34'] } });
    const { browser, csrf } = await signedInOperator(harness);
    const saved = await browser.submit('/account/actions', {
      csrf,
      ...SQL,
      'destination.host': '',
      address_from: APP_URL,
    });
    expect(saved.status).toBe(303);
    expect(harness.actions.engine.targets.get('id-1')?.destination).toMatchObject({
      host: 'app.example.com',
      port: 1433,
    });
  });

  it('ACT-2 refuses to choose silently between a typed address and a different one from the item', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const both = await browser.submit('/account/actions', {
      csrf,
      ...SQL,
      'destination.host': 'db.example.com',
      address_from: APP_URL,
    });
    expect(both.status).toBe(400);
    const markup = compact(await both.text());
    expect(markup).toContain(
      'an address is typed here and another is taken from the vault item; keep one of them',
    );
    expect(markup).toContain('value="db.example.com"');
    const forged = await browser.submit('/account/actions', {
      csrf,
      ...SQL,
      address_from: 'not a host!',
    });
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain('names no host');
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });

  it('ACT-2 leaves an existing computer’s address alone unless another is chosen on the edit page', async () => {
    const harness = createPagesHarness({ addresses: { 'app.example.com': ['93.184.216.34'] } });
    const target = await createSqlTarget(harness.actions, { engine: 'mssql' });
    const { browser, csrf } = await signedInOperator(harness);
    const edit = compact(await pageText(browser, `/account/actions/${target.id}/edit`));
    expect(edit).toContain('<option value="" selected>No: use what is typed above</option>');
    const saved = await browser.submit(`/account/actions/${target.id}`, {
      csrf,
      ...SQL,
      'destination.host': '',
      address_from: 'https://app.example.com:1444/',
    });
    expect(saved.status).toBe(303);
    expect(harness.actions.engine.targets.get(target.id)?.destination).toMatchObject({
      host: 'app.example.com',
      port: 1444,
    });
  });
});
