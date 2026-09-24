/**
 * The create and edit forms of a target (ACT-2, ACT-6): the common fields
 * (name at creation only, description, `internal`), the chosen vault item
 * with the way to choose another, and the connector's fields from its
 * descriptors, the ones naming a vault field offered from the item's own
 * fields (ACT-4); re-shown with every problem after a rejected submission.
 * There is no secret in any of these forms.
 */
import { unlockPath } from '../../identity/pages/console.ts';
import { icon } from '../../identity/pages/icons.ts';
import {
  EMPTY,
  errorBanner,
  hidden,
  type Html,
  html,
  when,
} from '../../identity/pages/template.ts';
import { cardHead } from '../../identity/pages/ui.ts';

import { fieldErrors, renderFields } from './form-render.ts';
import { fieldName, type FormValues } from './form-values.ts';
import { itemFields } from './item-fields.ts';
import { itemChips, itemLine } from './item-view.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FieldProblems } from './messages.ts';
import type { ItemSummary } from '../../vault/client.ts';

export const CONNECTOR_FIELD = 'connector';
export const NAME_FIELD = 'name';
export const DESCRIPTION_FIELD = 'description';
export const INTERNAL_FIELD = 'internal';
export const ITEM_ID_FIELD = 'credential.item_id';

/**
ACT-6: the controls a problem may name, so one that names none is listed instead of hidden.
*/
export function drawnPaths(form: ConnectorForm): readonly string[] {
  return [
    NAME_FIELD,
    DESCRIPTION_FIELD,
    INTERNAL_FIELD,
    ITEM_ID_FIELD,
    ...form.fields.map((field) => fieldName(field)),
  ];
}

/**
The vault item the form maps (ACT-4), as read for this page, and where to choose another.
*/
export type ChosenItem = { readonly changeHref: string } & (
  | { readonly state: 'found'; readonly summary: ItemSummary }
  | { readonly state: 'unreadable'; readonly id: string; readonly reason: string }
);

export interface TargetFormView {
  readonly action: string;
  readonly csrfToken: string;
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly problems: FieldProblems;
  /**
  The name is fixed at creation (ACT-1); the edit form does not offer it.
  */
  readonly isNew: boolean;
  readonly submitLabel: string;
  readonly item: ChosenItem;
}

function nameField(view: TargetFormView): Html {
  const { values } = view;
  return html`${fieldErrors(view.problems, NAME_FIELD)}<label
      >Name
      <input
        name="${NAME_FIELD}"
        value="${values.get(NAME_FIELD) ?? ''}"
        required
        maxlength="63"
        pattern="[a-z0-9][a-z0-9-]{0,62}"
        autocomplete="off"
      />
      <small
        >Lower-case letters, digits and hyphens; how agents name the target. Renaming is a new
        target.</small
      >
    </label>`;
}

function commonFields(view: TargetFormView): Html {
  const isInternal = view.values.get(INTERNAL_FIELD) === 'on';
  return html`<section class="card">
    ${cardHead('The computer', 'How agents know it, and whether it lives on your own network.')}
    ${when(view.isNew, () => nameField(view))} ${fieldErrors(view.problems, DESCRIPTION_FIELD)}
    <label
      >Description
      <textarea name="${DESCRIPTION_FIELD}" rows="2" maxlength="200">
${view.values.get(DESCRIPTION_FIELD) ?? ''}</textarea>
      <small
        >Shown to agents by actions_list_targets; say what the destination is and what to use it
        for.</small
      >
    </label>
    ${fieldErrors(view.problems, INTERNAL_FIELD)}
    <label
      ><input name="${INTERNAL_FIELD}" type="checkbox" ${when(isInternal, () => html`checked`)} />
      Internal destination (may resolve to a private address; loopback and link-local are refused
      whatever this says)</label
    >
  </section>`;
}

function chosenItem(item: ChosenItem): Html {
  return item.state === 'found'
    ? html`<div class="item-chosen">${itemLine(item.summary)} ${itemChips(item.summary)}</div>`
    : html`<p class="field-error">
        The item <code>${item.id}</code> could not be read: ${item.reason}.
      </p>`;
}

function itemCard(view: TargetFormView): Html {
  const { item } = view;
  const id = item.state === 'found' ? item.summary.id : item.id;
  const change = html`<a class="button small" href="${item.changeHref}"
    >${icon('search')} Choose another item</a
  >`;
  return html`<section class="card" id="vault-item">
    ${cardHead(
      'Vault item',
      'The Bitwarden item that signs in. vaultgate keeps its id and the names of the fields it reads, never a value.',
      change,
    )}
    ${hidden(ITEM_ID_FIELD, id)} ${fieldErrors(view.problems, ITEM_ID_FIELD)} ${chosenItem(item)}
  </section>`;
}

/**
 * ACT-6: the banner a rejected save carries, with the problems that name no
 * control of the form; the rest are shown against the control they name.
 */
export function renderProblems(problems: FieldProblems): Html {
  if (problems.isEmpty) {
    return EMPTY;
  }
  const items = problems.rest.map((problem) => html`<li>${problem}</li>`);
  return html`${errorBanner(
    'The computer was not saved; fix the problems shown against each field and try again.',
  )}
  ${when(
    problems.rest.length > 0,
    () =>
      html`<ul class="error">
        ${items}
      </ul>`,
  )}`;
}

/**
 * The connector is fixed at creation (ACT-1) and the create route reads it
 * from the submission, so the create form carries it; the edit form does not,
 * because the route takes the target's own connector.
 */
function connectorField(view: TargetFormView): Html {
  return when(view.isNew, () => hidden(CONNECTOR_FIELD, view.form.kind));
}

function submitRow(view: TargetFormView): Html {
  return html`<div class="form-actions">
    <button type="submit" class="primary">${view.submitLabel}</button>
  </div>`;
}

/**
 * ID-15: without a fresh confirmation the page offers the way to one instead
 * of the form, so nothing typed is lost on the way; confirming the password
 * comes back to `returnTo`.
 */
export function lockedForm(returnTo: string, what: string): Html {
  return html`<section class="card narrow">
    ${cardHead('Unlock editing first', `${what} needs your password, confirmed in the last five minutes.`)}
    <p>
      <a class="button primary" href="${unlockPath(returnTo)}">${icon('lock')}Unlock editing</a>
    </p>
  </section>`;
}

export function renderTargetForm(view: TargetFormView): Html {
  const { item } = view;
  const fields = {
    values: view.values,
    problems: view.problems,
    itemFields: item.state === 'found' ? itemFields(item.summary) : undefined,
  };
  return html`<form method="post" action="${view.action}" class="target-form">
    ${hidden('csrf', view.csrfToken)} ${connectorField(view)} ${commonFields(view)}
    ${itemCard(view)} ${renderFields(view.form, fields)} ${submitRow(view)}
  </form>`;
}
