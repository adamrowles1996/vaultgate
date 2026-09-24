/**
 * Choosing the vault item (ACT-2, ACT-4, ACT-5): the step of "Add computer",
 * and of changing a computer's item, where the operator finds the Bitwarden
 * item that signs in by its name, username or address. The search reads item
 * summaries only, so no secret leaves the vault; each result shows its name,
 * login name, first address and the fields it has, a secret field by name
 * only. The chosen item's id goes on to the form, and an id can be pasted
 * instead. Like the form it leads to, the step is only reached inside the
 * ID-15 window, so nothing is searched for a page that could not be used.
 */
import { icon } from '../../identity/pages/icons.ts';
import { errorBanner, hidden, type Html, html } from '../../identity/pages/template.ts';
import { cardHead } from '../../identity/pages/ui.ts';

import { type StepFrame, stepPage } from './form-pages.ts';
import { itemChips, itemLine } from './item-view.ts';

import type { ConsolePage } from '../../identity/index.ts';
import type { ItemSummary } from '../../vault/client.ts';

/**
How many items one search shows; a longer list is a search to narrow, not a page to scroll.
*/
export const SEARCH_LIMIT = 20;
export const QUERY_PARAM = 'q';
export const ITEM_PARAM = 'item';

export type ItemSearch =
  | { readonly ok: true; readonly items: readonly ItemSummary[] }
  | { readonly ok: false; readonly reason: string };

export interface ItemPickerView {
  readonly frame: StepFrame;
  /**
  Where both GET forms go, and the parameters they carry along (the connector and kind, …).
  */
  readonly action: string;
  readonly carried: Readonly<Record<string, string>>;
  readonly pickHref: (itemId: string) => string;
  readonly query: string;
  readonly search: ItemSearch;
}

function carriedFields(view: ItemPickerView): Html {
  return html`${Object.entries(view.carried).map(([name, value]) => hidden(name, value))}`;
}

function searchCard(view: ItemPickerView): Html {
  return html`<section class="card">
    <form method="get" action="${view.action}" class="search-form" role="search">
      ${carriedFields(view)}
      <label
        >Find the item
        <input
          type="search"
          name="${QUERY_PARAM}"
          value="${view.query}"
          placeholder="Name, username or address"
          autocomplete="off"
        />
      </label>
      <button type="submit" class="primary">${icon('search')} Search</button>
    </form>
    <details>
      <summary>Paste an item id instead</summary>
      <form method="get" action="${view.action}">
        ${carriedFields(view)}
        <label
          >Vault item id
          <input name="${ITEM_PARAM}" required autocomplete="off" />
        </label>
        <button type="submit">Use this id</button>
      </form>
    </details>
  </section>`;
}

function resultRow(item: ItemSummary, view: ItemPickerView): Html {
  return html`<li class="item-row">
    ${itemLine(item)} ${itemChips(item)}
    <a class="button small" href="${view.pickHref(item.id)}">Use this item</a>
  </li>`;
}

function resultsNote(query: string, count: number): string {
  if (count === SEARCH_LIMIT) {
    return `The first ${String(SEARCH_LIMIT)}; search to narrow them down.`;
  }
  return query === ''
    ? 'Every item, in the order the vault lists them.'
    : `${String(count)} found.`;
}

function resultsCard(view: ItemPickerView, search: ItemSearch): Html {
  if (!search.ok) {
    return errorBanner(
      `The vault cannot be searched right now: ${search.reason}. The Vault page shows its state.`,
    );
  }
  const title = view.query === '' ? 'Items in the vault' : `Items matching “${view.query}”`;
  const rows =
    search.items.length === 0
      ? html`<p class="empty">
          No item matches. Search by the item's name, its username or an address it holds.
        </p>`
      : html`<ul class="item-rows">
          ${search.items.map((item) => resultRow(item, view))}
        </ul>`;
  return html`<section class="card flush">
    ${cardHead(title, resultsNote(view.query, search.items.length))} ${rows}
  </section>`;
}

export function itemPickerPage(view: ItemPickerView): ConsolePage {
  return stepPage(
    view.frame,
    'Choose the vault item that signs in. Its fields are listed by name; a secret one is sealed and its value never leaves the vault.',
    html`${searchCard(view)} ${resultsCard(view, view.search)}`,
  );
}
