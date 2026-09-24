/**
 * A vault item as the Computers pages draw it (ACT-4): its name, its login
 * name and first address, and a chip per field a mapping may name, a secret
 * field sealed with its name only. Everything here comes from the item's
 * summary, which carries no secret.
 */
import { icon, type IconName } from '../../identity/pages/icons.ts';
import { type Html, html } from '../../identity/pages/template.ts';
import { fieldChip, sealed } from '../../identity/pages/ui.ts';

import { itemFields } from './item-fields.ts';

import type { ItemSummary, ItemType } from '../../vault/client.ts';

const ITEM_ICONS: Readonly<Record<ItemType, IconName>> = {
  login: 'key',
  secureNote: 'file',
  card: 'lock',
  identity: 'user',
  sshKey: 'terminal',
};

/**
 * The host of an address the vault holds, or the address as written when it
 * names none: `db.example.com:1433` parses as a URL whose scheme is the host
 * name, with no host at all.
 */
function hostOf(uri: string): string {
  const parsed = URL.parse(uri);
  return parsed === null || parsed.host === '' ? uri : parsed.host;
}

/**
The login name and the first address, whichever the item has.
*/
function detailOf(item: ItemSummary): string {
  const username = item.login?.username ?? undefined;
  const uri = item.login?.uris[0];
  return [username, uri === undefined ? undefined : hostOf(uri)]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
}

export function itemLine(item: ItemSummary): Html {
  return html`<span class="cell-with-tile"
    ><span class="item-mark" aria-hidden="true">${icon(ITEM_ICONS[item.type])}</span
    ><span class="cell-main"
      ><span class="strong">${item.name}</span><span class="cell-sub">${detailOf(item)}</span></span
    ></span
  >`;
}

export function itemChips(item: ItemSummary): Html {
  const chips = itemFields(item).map((field) =>
    field.isSecret ? sealed(field.label) : fieldChip(field.label),
  );
  return html`<span class="chips">${chips}</span>`;
}
