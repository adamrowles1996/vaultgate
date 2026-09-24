import { describe, expect, it, vi } from 'vitest';

import { createHttpTarget } from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';
import { VaultError } from '../../vault/client.ts';

import { createFrame } from './form-pages.ts';
import { itemPickerPage, SEARCH_LIMIT } from './item-picker.ts';

import type { ItemSummary } from '../../vault/client.ts';

const NEW_SQL = '/account/actions/new?connector=sql&kind=mssql';

function escaped(path: string): string {
  return path.replaceAll('&', '&amp;');
}

function summary(index: number): ItemSummary {
  return {
    id: `item-${String(index)}`,
    name: `Item ${String(index)}`,
    type: 'secureNote',
    folderId: null,
    organizationId: null,
    collectionIds: [],
    favorite: false,
    revisionDate: '2026-09-01T09:00:00.000Z',
    deletedDate: null,
    login: null,
    hasNotes: false,
    customFields: [],
  };
}

describe('Add computer: choosing the vault item', () => {
  it('ACT-4 ACT-5 finds the item by name, username or address and shows its fields, secret ones by name only', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, `${NEW_SQL}&q=alice`));
    expect(markup).toContain('<h1>Add SQL Server</h1>');
    expect(markup).toContain('<input type="hidden" name="connector" value="sql" />');
    expect(markup).toContain('<input type="hidden" name="kind" value="mssql" />');
    expect(markup).toMatch(/name="q"\s+value="alice"/u);
    expect(markup).toContain('Items matching “alice”');
    expect(markup).toContain('<span class="strong">Example Login</span>');
    expect(markup).toContain('<span class="cell-sub">alice@example.com · app.example.com</span>');
    expect(markup).toContain('<span class="field-chip">Username</span>');
    expect(markup).toContain('</svg>Password</span>');
    expect(markup).toContain('</svg>One-time code (TOTP)</span>');
    expect(markup).toContain('<span class="field-chip">Environment</span>');
    expect(markup).toContain('</svg>API key</span>');
    expect(markup).not.toContain('MFA enrolled');
    expect(markup).not.toContain('CANARY');
    expect(markup).toContain(`href="${escaped(`${NEW_SQL}&item=item-login`)}">Use this item</a>`);
    expect(markup).toContain('2 found.');
    expect(markup).toContain('<summary>Paste an item id instead</summary>');
    expect(markup).toContain('<input name="item" required autocomplete="off" />');
  });

  it('ACT-5 lists the vault until a search narrows it, says when nothing matches, and when the vault cannot be searched', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const everything = compact(await pageText(browser, NEW_SQL));
    expect(everything).toContain('Items in the vault');
    expect(everything).toContain('Every item, in the order the vault lists them.');
    expect(everything).toContain('<span class="strong">Deploy Key</span>');
    const nothing = compact(await pageText(browser, `${NEW_SQL}&q=zzz`));
    expect(nothing).toContain('No item matches.');
    harness.actions.vault.failWith(new VaultError('vault_unavailable', 'the vault is locked'));
    const locked = compact(await pageText(browser, `${NEW_SQL}&q=alice`));
    expect(locked).toContain(
      'The vault cannot be searched right now: the vault is locked. The Vault page shows its state.',
    );
  });

  it('ACT-5 says when a search shows only the first items', () => {
    const items = Array.from({ length: SEARCH_LIMIT }, (_, index) => summary(index));
    const page = itemPickerPage({
      frame: createFrame('ssh', '/x'),
      action: '/x',
      carried: {},
      pickHref: (id) => `/x?item=${id}`,
      query: 'item',
      search: { ok: true, items },
    });
    expect(compact(page.body.markup)).toContain('The first 20; search to narrow them down.');
  });

  it('ID-15 ACT-5 asks for the password before the item step and reads nothing from the vault until then', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness, false);
    const search = vi.spyOn(harness.actions.vault, 'searchItems');
    const item = vi.spyOn(harness.actions.vault, 'getItem');
    const picker = compact(await pageText(browser, `${NEW_SQL}&q=alice`));
    expect(picker).toContain(
      `href="/account/unlock?next=${encodeURIComponent(`${NEW_SQL}&q=alice`)}"`,
    );
    const form = compact(await pageText(browser, `${NEW_SQL}&item=item-login`));
    expect(form).toContain('Unlock editing');
    expect(form).not.toContain('Example Login');
    expect(search).not.toHaveBeenCalled();
    expect(item).not.toHaveBeenCalled();
  });
});

describe('the form with the chosen item', () => {
  it('ACT-4 ACT-6 offers the item’s own fields to sign in with, the defaults preselected', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, `${NEW_SQL}&item=item-login`));
    expect(markup).toContain(
      '<input type="hidden" name="credential.item_id" value="item-login" />',
    );
    expect(markup).toContain('<span class="strong">Example Login</span>');
    expect(markup).toContain(`href="${escaped(NEW_SQL)}"`);
    expect(markup).toContain('<select name="credential.username_from">');
    expect(markup).toContain(
      '<option value="login.username" selected>Username · alice@example.com</option>',
    );
    expect(markup).toContain(
      '<option value="custom.Environment" >Environment · production</option>',
    );
    expect(markup).toContain('<select name="credential.password_field">');
    expect(markup).toContain('<option value="password" selected>Password · secret</option>');
    expect(markup).toContain('<option value="custom.API key" >API key · secret</option>');
    expect(markup).not.toContain('<option value="login.username" >Username');
    expect(markup).not.toContain('CANARY');
  });

  it('ACT-4 flags a default the item does not carry rather than quietly mapping another field', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, `${NEW_SQL}&item=item-ssh`));
    expect(markup).toContain(
      '<option value="password" selected>password · not on this item</option>',
    );
    expect(markup).toContain(
      '<small class="warn">The item has no password field; choose the one that holds it.</small>',
    );
    const ssh = compact(
      await pageText(browser, '/account/actions/new?connector=ssh&kind=ssh&item=item-ssh'),
    );
    expect(ssh).toContain(
      '<select name="credential.passphrase_field"><option value="" selected>None</option>',
    );
    expect(ssh).toContain(
      '<option value="sshKey.privateKey" selected>SSH private key · secret</option>',
    );
  });

  it('ACT-4 names an item it cannot read and falls back to typed field names', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const missing = compact(await pageText(browser, `${NEW_SQL}&item=item-nope`));
    expect(missing).toContain(
      'The item <code>item-nope</code> could not be read: no such item in the vault.',
    );
    expect(missing).toContain('<input name="credential.password_field" value=""');
    harness.actions.vault.failWith(new VaultError('vault_unavailable', 'the vault is locked'));
    const locked = compact(await pageText(browser, `${NEW_SQL}&item=item-login`));
    expect(locked).toContain('could not be read: the vault is locked.');
  });

  it('ACT-4 ACT-5 lets an edit choose another item and keeps the choice through the form', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness);
    const edit = `/account/actions/${target.id}/edit`;
    const form = compact(await pageText(browser, edit));
    expect(form).toContain(`href="${edit}?change=item"`);
    const everything = compact(await pageText(browser, `${edit}?change=item`));
    expect(everything).toContain('Items in the vault');
    const picker = compact(await pageText(browser, `${edit}?change=item&q=deploy`));
    expect(picker).toContain('<h1>Edit api</h1>');
    expect(picker).toContain('<input type="hidden" name="change" value="item" />');
    expect(picker).toContain(`href="${edit}?item=item-ssh">Use this item</a>`);
    const pasted = compact(await pageText(browser, `${edit}?change=item&item=item-ssh`));
    expect(pasted).toContain('<input type="hidden" name="credential.item_id" value="item-ssh" />');
    expect(pasted).toContain('<span class="strong">Deploy Key</span>');
    expect(pasted).toContain(
      '<option value="password" selected>password · not on this item</option>',
    );
  });
});
