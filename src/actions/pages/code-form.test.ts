import { describe, expect, it } from 'vitest';

import { signedInOperator } from '../../test-support/actions-pages.ts';
import {
  CODE_FORM,
  createCodePages,
  GITHUB_ITEM_ID,
  PRIVATE_REPO,
  PUBLIC_REPO,
} from '../../test-support/code-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';

const NEW_CODE = `/account/actions/new?connector=code&kind=code&item=${GITHUB_ITEM_ID}`;

/**
The form's markup between two field names, for asserting on one control at a time.
*/
function between(markup: string, from: string, to: string): string {
  const start = markup.indexOf(from);
  return markup.slice(start, markup.indexOf(to, start + from.length));
}

describe('Add connection: Semble · GitHub code search', () => {
  it('ACT-5 ACT-119 offers the kind as a card of its own, with what it does and its tools', async () => {
    const { harness } = createCodePages();
    const { browser } = await signedInOperator(harness);
    const chooser = compact(await pageText(browser, '/account/actions/new'));
    expect(chooser).toContain(
      '<a class="choice" href="/account/actions/new?connector=code&amp;kind=code">',
    );
    expect(chooser).toContain('<span class="kind-tile large kind-code">');
    expect(chooser).toContain('<span class="choice-title">Semble · GitHub code search</span>');
    expect(chooser).toContain(
      'Search a GitHub repository with Semble, as your agents search a checkout: code, docs and config.',
    );
    expect(chooser).toContain(
      '<span class="choice-meta">code_search · code_find_related · code_read</span>',
    );
    const picker = compact(
      await pageText(browser, '/account/actions/new?connector=code&kind=code'),
    );
    expect(picker).toContain('<title>Add Semble · GitHub code search · vaultgate</title>');
    expect(picker).toContain('Use this item');
  });

  it('ACT-6 ACT-119 draws the form after the item with the schema’s defaults and ceilings, and no internal box or write confirmation', async () => {
    const { harness } = createCodePages();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, NEW_CODE));
    expect(markup).toContain('<input type="hidden" name="connector" value="code" />');
    expect(markup).toContain('name="name"');
    expect(markup).toContain('<textarea name="description"');
    expect(markup).not.toContain('name="internal"');
    expect(markup).not.toContain('policy.confirm_writes');
    expect(markup).toContain('<p class="card-note">How agents know it.</p>');
    expect(markup).toContain('The GitHub repository agents search.');
    expect(markup).toContain('Empty: the repository’s default branch');
    expect(markup).toContain('<input name="destination.ref" value="" autocomplete="off"  />');
    for (const type of ['code', 'docs', 'config']) {
      expect(markup).toContain(`name="policy.content.${type}" type="checkbox" checked`);
    }
    expect(markup).toContain('name="policy.allow_read" type="checkbox" checked');
    expect(markup).toContain('name="policy.allow_ref" type="checkbox" checked');
    expect(markup).toContain('<textarea name="policy.include" rows="4"></textarea>');
    expect(markup).toContain('<textarea name="policy.exclude" rows="4">.env\n.env.*\n*.pem');
    expect(markup).toContain('replacing the list replaces the defaults too');
    const numbers = {
      max_top_k: ['1', '200', '50'],
      max_read_lines: ['1', '2000', '400'],
      build_wait_s: ['0', '290', '90'],
      refresh_interval_s: ['60', '86400', '300'],
      max_archive_bytes: ['1048576', '1073741824', '268435456'],
      max_files: ['1', '200000', '50000'],
      max_total_bytes: ['1048576', '4294967296', '1073741824'],
      max_file_bytes: ['1024', '16777216', '1048576'],
      build_timeout_s: ['10', '3600', '600'],
      timeout_ms: ['1000', '300000', '150000'],
    };
    for (const [name, [min = '', max = '', value = '']] of Object.entries(numbers)) {
      const control = between(markup, `name="policy.${name}"`, '/>');
      expect(control).toContain(`min="${min}"`);
      expect(control).toContain(`max="${max}"`);
      expect(control).toContain(`value="${value}"`);
    }
  });

  it('ACT-4 ACT-119 offers the item’s fields for the token, hidden custom fields included, the password first and no token last', async () => {
    const { harness } = createCodePages();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, NEW_CODE));
    const select = between(markup, '<select name="credential.token_field">', '</select>');
    expect(select).toContain('<option value="password" selected>Password · secret</option>');
    expect(select).toContain('<option value="custom.AccessToken" >AccessToken · secret</option>');
    expect(select).toContain('<option value="none" >No token (public repository)</option>');
    expect(select).not.toContain('login.username');
    expect(select.indexOf('password')).toBeLessThan(select.indexOf('value="none"'));
  });

  it('ACT-6 ACT-119 saves the chosen token field, and none as null, and shows each again on the edit form', async () => {
    const { harness } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const created = await browser.submit('/account/actions', { csrf, ...CODE_FORM });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/account/actions/id-1?notice=created');
    expect(harness.actions.engine.targets.get('id-1')).toMatchObject({
      connector: 'code',
      internal: false,
      destination: { repository: PRIVATE_REPO.fullName },
      credential: { item_id: GITHUB_ITEM_ID, mapping: { token_field: 'custom.AccessToken' } },
      policy: { content: ['code', 'docs', 'config'], allow_read: true, allow_ref: true },
    });
    const edit = compact(await pageText(browser, '/account/actions/id-1/edit'));
    expect(edit).toContain(
      '<option value="custom.AccessToken" selected>AccessToken · secret</option>',
    );
    const saved = await browser.submit('/account/actions/id-1', {
      csrf,
      ...CODE_FORM,
      'destination.repository': PUBLIC_REPO.fullName,
      'destination.ref': 'trunk',
      'credential.token_field': 'none',
      'policy.content.config': '',
      'policy.allow_read': '',
    });
    expect(saved.status).toBe(303);
    const target = harness.actions.engine.targets.get('id-1');
    expect(target?.credential.mapping).toStrictEqual({ token_field: null });
    expect(target?.destination).toStrictEqual({ repository: 'acme/docs', ref: 'trunk' });
    const again = compact(await pageText(browser, '/account/actions/id-1/edit'));
    expect(again).toContain('<option value="none" selected>No token (public repository)</option>');
    expect(again).toContain('<option value="password" >Password · secret</option>');
    expect(again).toContain('<small>No token: type the public repository as owner/name.</small>');
  });

  it('ACT-4 ACT-119 flags a token field the item does not carry rather than replacing it', async () => {
    const { harness } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      ...CODE_FORM,
      'credential.token_field': 'custom.Gone',
    });
    expect(response.status).toBe(400);
    const markup = compact(await response.text());
    expect(markup).toContain(
      '<option value="custom.Gone" selected>custom.Gone · not on this item</option>',
    );
    expect(markup).toContain('the vault item has no such field (field_not_on_item)');
  });

  it('ACT-6 ACT-103 refuses an internal box a hand-made request sends, an invalid repository and a wait the timeout cannot hold', async () => {
    const { harness } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      ...CODE_FORM,
      internal: 'on',
    });
    expect(response.status).toBe(400);
    const markup = compact(await response.text());
    expect(markup).toContain('this connection reaches the internet only; it is never internal');
    const invalid = await browser.submit('/account/actions', {
      csrf,
      ...CODE_FORM,
      'destination.repository': 'not a repository',
    });
    expect(invalid.status).toBe(400);
    expect(compact(await invalid.text())).toContain(
      '<p class="field-error">The repository as owner/name, as GitHub shows it: type it, or choose one the token can read. (',
    );
    const waiting = await browser.submit('/account/actions', {
      csrf,
      ...CODE_FORM,
      'policy.build_wait_s': '200',
      'policy.timeout_ms': '60000',
    });
    expect(waiting.status).toBe(400);
    expect(compact(await waiting.text())).toContain(
      '<p class="field-error">How long a call waits for an index being built, in seconds: 0 to 290, and at least 10 seconds less than the call timeout. (must end at least 10 seconds before policy.timeout_ms)</p>',
    );
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });
});
