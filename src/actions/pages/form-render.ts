/**
 * Draws a connector form from its descriptors (ACT-6): one control per
 * field, grouped by document, showing the values given (a stored target, or
 * a rejected submission). A field that names a vault field becomes a list of
 * the chosen item's fields (ACT-4), secret ones by name only. No JavaScript
 * (ID-19): a mode's own fields are always drawn and their help says which
 * mode uses them.
 */
import { EMPTY, type Html, html, when } from '../../identity/pages/template.ts';
import { cardHead } from '../../identity/pages/ui.ts';

import { type AddressCandidate, ADDRESS_FROM_FIELD, canTakeAddress } from './address-source.ts';
import { fieldName, type FormValues, NO_FIELD, optionName } from './form-values.ts';
import { type ItemField, offeredFields, pickedSelector } from './item-fields.ts';
import { canFillField, type RepoOffer, repoSource } from './repo-source.ts';

import type { ConnectorForm, DocumentName, FieldDescriptor, FieldPicker } from './descriptors.ts';
import type { FieldProblems } from './messages.ts';

const DOCUMENT_LABELS: Readonly<Record<DocumentName, { title: string; note: string }>> = {
  destination: {
    title: 'Destination',
    note: 'Where the connection points. Saving resolves it and checks every address; it does not connect.',
  },
  credential: {
    title: 'Credential mapping',
    note: 'Which of the vault item’s fields sign in. Field names only: values stay in the vault.',
  },
  policy: {
    title: 'Rules',
    note: 'What agents may do here, how much, and whether a person confirms each change.',
  },
};

const DOCUMENTS: readonly DocumentName[] = ['destination', 'credential', 'policy'];

function help(field: FieldDescriptor): Html {
  return field.help === undefined ? EMPTY : html`<small>${field.help}</small>`;
}

/**
ACT-6: what a rejected save said about this one control, next to it.
*/
export function fieldErrors(problems: FieldProblems, path: string): Html {
  const messages = problems.byPath.get(path) ?? [];
  return html`${messages.map((message) => html`<p class="field-error">${message}</p>`)}`;
}

/**
A field the vault item can fill is not `required` in the browser, which would refuse a form left for the item to fill.
*/
function textInput(
  field: FieldDescriptor & { readonly kind: 'text' },
  value: string,
  isFilledByItem: boolean,
): Html {
  const required = when(field.required === true && !isFilledByItem, () => html`required`);
  const input =
    field.multiline === true
      ? html`<textarea name="${fieldName(field)}" rows="8" spellcheck="false" ${required}>
${value}</textarea>`
      : html`<input name="${fieldName(field)}" value="${value}" autocomplete="off" ${required} />`;
  return html`<label>${field.label} ${input} ${help(field)} </label>`;
}

type PickerField = FieldDescriptor & { readonly kind: 'text'; readonly picker: FieldPicker };

function pickerOption(value: string, label: string, isSelected: boolean): Html {
  return html`<option value="${value}" ${when(isSelected, () => html`selected`)}>${label}</option>`;
}

const PICKER_HELP: Readonly<Record<FieldPicker['role'], string>> = {
  username: 'The item’s field that holds the login name.',
  secret:
    'The item’s field that holds it. vaultgate reads the value at the moment of each call and never shows it.',
};

function describe(field: ItemField): string {
  return field.isSecret ? `${field.label} · secret` : `${field.label} · ${field.value}`;
}

/**
 * ACT-4 as the operator picks: the item's own fields, the one in use
 * selected. A name the item does not carry stays selected and is flagged, so
 * a save cannot quietly map a different field. A picker that offers no field
 * at all (ACT-119's public repository) lists that choice last.
 */
function fieldPicker(field: PickerField, value: string, fields: readonly ItemField[]): Html {
  const { picker } = field;
  const offered = offeredFields(fields, picker);
  const chosen = pickedSelector(value, picker);
  const none = 'none' in picker ? picker.none : undefined;
  const isNone = none !== undefined && chosen === NO_FIELD;
  const isMissing =
    chosen !== '' && !isNone && offered.every((candidate) => candidate.selector !== chosen);
  const options = [
    ...('optional' in picker ? [pickerOption('', 'None', chosen === '')] : []),
    ...(isMissing ? [pickerOption(chosen, `${chosen} · not on this item`, true)] : []),
    ...offered.map((candidate) =>
      pickerOption(candidate.selector, describe(candidate), candidate.selector === chosen),
    ),
    ...(none === undefined ? [] : [pickerOption(NO_FIELD, none, isNone)]),
  ];
  const note = isMissing
    ? html`<small class="warn"
        >The item has no ${chosen} field; choose the one that holds it.</small
      >`
    : html`<small>${PICKER_HELP[field.picker.role]}</small>`;
  return html`<label
    >${field.label}
    <select name="${fieldName(field)}">
      ${options}
    </select>
    ${note}
  </label>`;
}

function numberInput(field: FieldDescriptor & { readonly kind: 'number' }, value: string): Html {
  return html`<label
    >${field.label}
    <input
      name="${fieldName(field)}"
      type="number"
      inputmode="numeric"
      min="${field.min}"
      max="${field.max}"
      value="${value}"
    />
    ${help(field)}
  </label>`;
}

function checkbox(name: string, label: string, isChecked: boolean): Html {
  const checked = when(isChecked, () => html`checked`);
  return html`<label><input name="${name}" type="checkbox" ${checked} /> ${label}</label>`;
}

function select(field: FieldDescriptor & { readonly kind: 'select' }, value: string): Html {
  const options = field.options.map((option) => {
    const selected = when(option.value === value, () => html`selected`);
    return html`<option value="${option.value}" ${selected}>${option.label}</option>`;
  });
  return html`<label
    >${field.label}
    <select name="${fieldName(field)}">
      ${options}
    </select>
    ${help(field)}
  </label>`;
}

function lines(field: FieldDescriptor & { readonly kind: 'lines' }, value: string): Html {
  return html`<label
    >${field.label}
    <textarea name="${fieldName(field)}" rows="4">${value}</textarea>
    ${help(field)}
  </label>`;
}

function set(field: FieldDescriptor & { readonly kind: 'set' }, values: FormValues): Html {
  const boxes = field.options.map((option) =>
    checkbox(optionName(field, option), option, values.get(optionName(field, option)) === 'on'),
  );
  return html`<fieldset>
    <legend>${field.label}</legend>
    ${boxes} ${help(field)}
  </fieldset>`;
}

function control(
  field: FieldDescriptor,
  values: FormValues,
  fields: readonly ItemField[] | undefined,
  isFilledByItem: boolean,
): Html {
  const value = values.get(fieldName(field)) ?? '';
  switch (field.kind) {
    case 'text': {
      return fields === undefined || field.picker === undefined
        ? textInput(field, value, isFilledByItem)
        : fieldPicker({ ...field, picker: field.picker }, value, fields);
    }
    case 'number': {
      return numberInput(field, value);
    }
    case 'boolean': {
      return html`${checkbox(fieldName(field), field.label, value === 'on')} ${help(field)}`;
    }
    case 'select': {
      return select(field, value);
    }
    case 'lines': {
      return lines(field, value);
    }
    case 'set': {
      return set(field, values);
    }
  }
}

/**
What the form is drawn from: the values shown, the problems of a rejected save, the item's fields.
*/
export interface FieldsView {
  readonly values: FormValues;
  readonly problems: FieldProblems;
  /**
  The chosen item's fields (ACT-4); without them a field that names one is a text box.
  */
  readonly itemFields: readonly ItemField[] | undefined;
  /**
  The item's addresses and text fields, for the destination's address (ACT-2).
  */
  readonly addressCandidates: readonly AddressCandidate[];
  /**
  A new computer with no address typed takes the item's first one unless the operator says otherwise.
  */
  readonly isNew: boolean;
  /**
  The repositories the chosen token can read, for the repository field (ACT-119).
  */
  readonly repositories: RepoOffer;
}

/**
 * ACT-2: the item's addresses that fit the field, offered to copy in when
 * the computer is saved. On a new computer with nothing typed the first is
 * chosen; once the form has been submitted, what was submitted stands.
 */
function offeredAddresses(field: FieldDescriptor, view: FieldsView): readonly AddressCandidate[] {
  if (field.kind !== 'text' || field.address === undefined) {
    return [];
  }
  const { address } = field;
  return view.addressCandidates.filter((candidate) => canTakeAddress(address, candidate.value));
}

function addressSource(
  field: FieldDescriptor,
  view: FieldsView,
  offered: readonly AddressCandidate[],
): Html {
  const [first, ...rest] = offered;
  if (first === undefined) {
    return EMPTY;
  }
  const typed = view.values.get(fieldName(field)) ?? '';
  const chosen =
    view.values.get(ADDRESS_FROM_FIELD) ?? (typed === '' && view.isNew ? first.value : '');
  const options = [first, ...rest].map((candidate) =>
    pickerOption(
      candidate.value,
      `${candidate.value} · ${candidate.source}`,
      chosen === candidate.value,
    ),
  );
  return html`<label
    >Take the address from the vault item
    <select name="${ADDRESS_FROM_FIELD}">
      ${pickerOption('', 'No: use what is typed above', chosen === '')} ${options}
    </select>
    <small
      >Copied when you save: the connection keeps that address, and a later change in the vault does
      not move it.</small
    >
  </label>`;
}

function renderField(field: FieldDescriptor, view: FieldsView): Html {
  const offered = offeredAddresses(field, view);
  const isFilledBeside = offered.length > 0 || canFillField(field, view.repositories);
  return html`${fieldErrors(view.problems, fieldName(field))}
  ${control(field, view.values, view.itemFields, isFilledBeside)}
  ${addressSource(field, view, offered)} ${repoSource(field, view.repositories, view.values)}`;
}

/**
Every field of the form, one card per document.
*/
export function renderFields(form: ConnectorForm, view: FieldsView): Html {
  const groups = DOCUMENTS.map((document) => {
    const fields = form.fields
      .filter((field) => field.document === document)
      .map((field) => renderField(field, view));
    const { title, note } = DOCUMENT_LABELS[document];
    return html`<section class="card">
      ${cardHead(title, note)}
      <div class="fields">${fields}</div>
    </section>`;
  });
  return html`${groups}`;
}
