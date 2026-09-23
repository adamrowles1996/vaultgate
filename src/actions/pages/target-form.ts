/**
 * The create and edit forms of a target (ACT-2, ACT-6): the common fields
 * (name at creation only, description, `internal`, the vault item id) and
 * the connector's fields from its descriptors, re-shown with every problem
 * after a rejected submission. There is no secret in any of these forms.
 */
import {
  EMPTY,
  errorBanner,
  hidden,
  type Html,
  html,
  when,
} from '../../identity/pages/template.ts';

import { renderFields } from './form-render.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormValues } from './form-values.ts';

export const CONNECTOR_FIELD = 'connector';
export const NAME_FIELD = 'name';
export const DESCRIPTION_FIELD = 'description';
export const INTERNAL_FIELD = 'internal';
export const ITEM_ID_FIELD = 'credential.item_id';

export interface TargetFormView {
  readonly action: string;
  readonly csrfToken: string;
  readonly form: ConnectorForm;
  readonly values: FormValues;
  /**
  The name is fixed at creation (ACT-1); the edit form does not offer it.
  */
  readonly isNew: boolean;
  readonly submitLabel: string;
}

function nameField(values: FormValues): Html {
  return html`<label
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
  return html`${when(view.isNew, () => nameField(view.values))}
    <label
      >Description
      <textarea name="${DESCRIPTION_FIELD}" rows="2" maxlength="200">
${view.values.get(DESCRIPTION_FIELD) ?? ''}</textarea>
      <small
        >Shown to agents by actions_list_targets; say what the destination is and what to use it
        for.</small
      >
    </label>
    <label
      ><input name="${INTERNAL_FIELD}" type="checkbox" ${when(isInternal, () => html`checked`)} />
      Internal destination (may resolve to a private address; loopback and link-local are refused
      whatever this says)</label
    >
    <label
      >Vault item id
      <input
        name="${ITEM_ID_FIELD}"
        value="${view.values.get(ITEM_ID_FIELD) ?? ''}"
        required
        autocomplete="off"
      />
      <small
        >The id of the vault item holding the credential; it must exist and carry every mapped
        field. Its name is shown once the target is saved.</small
      >
    </label>`;
}

/**
The problems a rejected save reported, every one of them (ACT-6).
*/
export function renderProblems(problems: readonly string[]): Html {
  if (problems.length === 0) {
    return EMPTY;
  }
  const items = problems.map((problem) => html`<li>${problem}</li>`);
  return html`${errorBanner('The target was not saved; fix the problems below and try again.')}
    <ul class="error">
      ${items}
    </ul>`;
}

/**
 * The connector is fixed at creation (ACT-1) and the create route reads it
 * from the submission, so the create form carries it; the edit form does not,
 * because the route takes the target's own connector.
 */
function connectorField(view: TargetFormView): Html {
  return when(view.isNew, () => hidden(CONNECTOR_FIELD, view.form.kind));
}

export function renderTargetForm(view: TargetFormView): Html {
  return html`<form method="post" action="${view.action}">
    ${hidden('csrf', view.csrfToken)} ${connectorField(view)} ${commonFields(view)}
    ${renderFields(view.form, view.values)}
    <button type="submit">${view.submitLabel}</button>
  </form>`;
}
