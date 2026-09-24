import { describe, expect, it } from 'vitest';

import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact, pageText, statusOf } from '../../test-support/identity-app.ts';

import { formFor } from './forms.ts';
import { formKind, kindChoices, prefilled } from './prefill.ts';

import type { ConnectorForm } from './descriptors.ts';

const SWITCHES = { allowAnyCommand: false };

function formOf(kind: 'sql' | 'http' | 'ssh'): ConnectorForm {
  const form = formFor(kind, SWITCHES);
  if (form === undefined) {
    throw new Error(`no ${kind} form`);
  }
  return form;
}

describe('Add computer', () => {
  it('ACT-5 offers one card per kind this build can create, each opening its connector’s form', () => {
    expect(kindChoices().map((choice) => [choice.kind, choice.href])).toStrictEqual([
      ['mssql', '/account/actions/new?connector=sql&kind=mssql'],
      ['postgres', '/account/actions/new?connector=sql&kind=postgres'],
      ['winrm', '/account/actions/new?connector=winrm&kind=winrm'],
      ['ssh', '/account/actions/new?connector=ssh&kind=ssh'],
      ['http', '/account/actions/new?connector=http&kind=http'],
      ['graph', '/account/actions/new?connector=http&kind=graph'],
    ]);
    expect(kindChoices().every((choice) => choice.description.length > 0)).toBe(true);
  });

  it('ACT-5 fills in what a kind implies, and nothing for a kind it does not know', () => {
    const sql = formOf('sql');
    const mssql = prefilled(sql, 'mssql');
    expect(mssql.get('destination.engine')).toBe('mssql');
    expect(mssql.get('destination.port')).toBe('1433');
    expect(formKind(sql, mssql)).toBe('mssql');
    expect(formKind(sql, prefilled(sql, 'postgres'))).toBe('postgres');
    const http = formOf('http');
    const graph = prefilled(http, 'graph');
    expect(graph.get('credential.mode')).toBe('graph');
    expect(graph.get('destination.base_url')).toBe('https://graph.microsoft.com/v1.0');
    expect(formKind(http, graph)).toBe('graph');
    expect(formKind(http, prefilled(http, 'constructor'))).toBe('http');
    const ssh = formOf('ssh');
    expect(formKind(ssh, prefilled(ssh, undefined))).toBe('ssh');
  });

  it('ACT-5 ID-15 walks from the kinds to a filled-in form behind the password check', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const chooser = compact(await pageText(browser, '/account/actions/new'));
    expect(chooser).toContain('<h1>Add a computer</h1>');
    expect(chooser).toContain(
      '<a class="choice" href="/account/actions/new?connector=sql&amp;kind=mssql">',
    );
    expect(chooser).toContain('<span class="choice-title">Microsoft Graph</span>');
    const picker = compact(
      await pageText(browser, '/account/actions/new?connector=sql&kind=mssql'),
    );
    expect(picker).toContain('<title>Add SQL Server · vaultgate</title>');
    const pick = '/account/actions/new?connector=sql&kind=mssql&item=item-login';
    expect(picker).toContain(`href="${pick.replaceAll('&', '&amp;')}">Use this item</a>`);
    const form = compact(await pageText(browser, pick));
    expect(form).toContain('<title>Add SQL Server · vaultgate</title>');
    expect(form).toContain('<option value="mssql" selected>mssql</option>');
    expect(form).toContain('value="1433"');
    expect(await statusOf(browser, '/account/actions/new?connector=nope')).toBe(404);
  });
});
