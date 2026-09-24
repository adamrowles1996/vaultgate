/**
 * The vault item step of "Add computer" and "Edit" (ACT-4, ACT-5): the item
 * a form maps, read for the page (metadata only), and the search that finds
 * one. The search runs only for a page inside the ID-15 window; the routes
 * check that before they get here.
 */
import { withParameters } from './form-input.ts';
import { itemPickerPage, type ItemSearch, ITEM_PARAM, SEARCH_LIMIT } from './item-picker.ts';

import type { StepFrame } from './form-pages.ts';
import type { ChosenItem } from './target-form.ts';
import type { ActionsPagesDependencies, Viewer } from './view.ts';

/**
The chosen item as the form shows it: its summary, or why it could not be read (ACT-4).
*/
export async function chosenItem(
  dependencies: ActionsPagesDependencies,
  id: string,
  changeHref: string,
): Promise<ChosenItem> {
  const found = await dependencies.vault.getItem(id);
  if (found.ok) {
    return { state: 'found', summary: found.value, changeHref };
  }
  const reason =
    found.error.code === 'not_found' ? 'no such item in the vault' : found.error.message;
  return { state: 'unreadable', id, reason, changeHref };
}

async function searchVault(
  dependencies: ActionsPagesDependencies,
  query: string,
): Promise<ItemSearch> {
  const found = await dependencies.vault.searchItems({
    ...(query !== '' && { text: query }),
    limit: SEARCH_LIMIT,
  });
  return found.ok ? { ok: true, items: found.value } : { ok: false, reason: found.error.message };
}

interface PickerRequest {
  readonly frame: StepFrame;
  readonly action: string;
  /**
  What the search and the pasted id carry along; a picked item keeps only `picked`.
  */
  readonly carried: Readonly<Record<string, string>>;
  readonly picked: Readonly<Record<string, string>>;
  readonly query: string;
}

export async function renderPicker(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  request: PickerRequest,
): Promise<string> {
  const { picked, action } = request;
  const page = itemPickerPage({
    ...request,
    pickHref: (itemId) => withParameters(action, { ...picked, [ITEM_PARAM]: itemId }),
    search: await searchVault(dependencies, request.query),
  });
  return dependencies.renderConsole(viewer.session, page);
}
