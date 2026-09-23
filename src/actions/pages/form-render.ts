/**
 * Draws a connector form from its descriptors (ACT-6): one control per
 * field, grouped by document, showing the values given (a stored target, or
 * a rejected submission). No JavaScript (ID-19): a mode's own fields are
 * always drawn and their help says which mode uses them.
 */
import { EMPTY, type Html, html, when } from '../../identity/pages/template.ts';

import { fieldName, type FormValues, optionName } from './form-values.ts';

import type { ConnectorForm, DocumentName, FieldDescriptor } from './descriptors.ts';

const DOCUMENT_LABELS: Readonly<Record<DocumentName, string>> = {
  destination: 'Destination',
  credential: 'Credential mapping',
  policy: 'Policy',
};

const DOCUMENTS: readonly DocumentName[] = ['destination', 'credential', 'policy'];

function help(field: FieldDescriptor): Html {
  return field.help === undefined ? EMPTY : html`<small>${field.help}</small>`;
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

function renderField(field: FieldDescriptor, values: FormValues): Html {
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

/**
Every field of the form, one fieldset per document, showing `values`.
*/
export function renderFields(form: ConnectorForm, values: FormValues): Html {
  const groups = DOCUMENTS.map((document) => {
    const fields = form.fields
      .filter((field) => field.document === document)
      .map((field) => renderField(field, values));
    return html`<fieldset>
      <legend>${DOCUMENT_LABELS[document]}</legend>
      ${fields}
    </fieldset>`;
  });
  return html`${groups}`;
}
