/**
 * Draws a connector form from its descriptors (ACT-6): one control per
 * field, grouped by document, showing the values given (a stored target, or
 * a rejected submission). No JavaScript (ID-19): a mode's own fields are
 * always drawn and their help says which mode uses them.
 */
import { EMPTY, type Html, html, when } from '../../identity/pages/template.ts';
import { cardHead } from '../../identity/pages/ui.ts';

import { fieldName, type FormValues, optionName } from './form-values.ts';

import type { ConnectorForm, DocumentName, FieldDescriptor } from './descriptors.ts';
import type { FieldProblems } from './messages.ts';

const DOCUMENT_LABELS: Readonly<Record<DocumentName, { title: string; note: string }>> = {
  destination: {
    title: 'Destination',
    note: 'Where the computer is. Saving resolves it and checks every address; it does not connect.',
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

function textInput(field: FieldDescriptor & { readonly kind: 'text' }, value: string): Html {
  const required = when(field.required === true, () => html`required`);
  return html`<label
    >${field.label}
    <input name="${fieldName(field)}" value="${value}" autocomplete="off" ${required} />
    ${help(field)}
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

function control(field: FieldDescriptor, values: FormValues): Html {
  const value = values.get(fieldName(field)) ?? '';
  switch (field.kind) {
    case 'text': {
      return textInput(field, value);
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

function renderField(field: FieldDescriptor, values: FormValues, problems: FieldProblems): Html {
  return html`${fieldErrors(problems, fieldName(field))} ${control(field, values)}`;
}

/**
Every field of the form, one card per document, showing `values`.
*/
export function renderFields(
  form: ConnectorForm,
  values: FormValues,
  problems: FieldProblems,
): Html {
  const groups = DOCUMENTS.map((document) => {
    const fields = form.fields
      .filter((field) => field.document === document)
      .map((field) => renderField(field, values, problems));
    const { title, note } = DOCUMENT_LABELS[document];
    return html`<section class="card">
      ${cardHead(title, note)}
      <div class="fields">${fields}</div>
    </section>`;
  });
  return html`${groups}`;
}
