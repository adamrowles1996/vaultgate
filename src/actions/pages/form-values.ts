/**
 * The two directions between a form and the target documents (ACT-6): a
 * submitted form becomes the three documents the targets service validates
 * with the connector's zod schemas, and a stored (or just submitted) target
 * becomes the values the form shows again. Fields are named
 * `<document>.<field>`; a set of checkboxes adds `.<option>`. A field whose
 * `when` clause does not hold for the submitted mode is left out, so the
 * strict schemas see only the chosen mode's fields.
 */
import type { ConnectorForm, DocumentName, FieldDescriptor } from './descriptors.ts';

export type FormValues = ReadonlyMap<string, string>;

export type Documents = Readonly<Record<DocumentName, Readonly<Record<string, unknown>>>>;

export function fieldName(field: Pick<FieldDescriptor, 'document' | 'name'>): string {
  return `${field.document}.${field.name}`;
}

export function optionName(field: FieldDescriptor, option: string): string {
  return `${fieldName(field)}.${option}`;
}

/**
Whether the field is in use: unconditional, or its controlling sibling holds one of the listed values.
*/
export function isActive(field: FieldDescriptor, values: FormValues): boolean {
  if (field.when === undefined) {
    return true;
  }
  const controller = values.get(`${field.document}.${field.when.field}`);
  return controller !== undefined && field.when.values.includes(controller);
}

function splitLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
An empty text, list or set is left out, so the schema's default or its "required" applies.
*/
function orAbsent<T extends string | readonly string[]>(value: T): T | undefined {
  return value.length === 0 ? undefined : value;
}

function readScalar(field: FieldDescriptor, raw: string): unknown {
  const text = orAbsent(raw.trim());
  switch (field.kind) {
    case 'number': {
      return text === undefined ? undefined : Number(text);
    }
    case 'boolean': {
      return raw === 'on';
    }
    default: {
      return text;
    }
  }
}

/**
The document value a submitted field stands for.
*/
function readField(field: FieldDescriptor, values: FormValues): unknown {
  const raw = values.get(fieldName(field)) ?? '';
  switch (field.kind) {
    case 'lines': {
      return orAbsent(splitLines(raw));
    }
    case 'set': {
      return orAbsent(
        field.options.filter((option) => values.get(optionName(field, option)) === 'on'),
      );
    }
    default: {
      return readScalar(field, raw);
    }
  }
}

/**
The three documents a submitted form describes, ready for the connector's schemas.
*/
export function documentsFromForm(form: ConnectorForm, values: FormValues): Documents {
  const documents: Record<DocumentName, Record<string, unknown>> = {
    destination: {},
    credential: {},
    policy: {},
  };
  for (const field of form.fields) {
    const value = isActive(field, values) ? readField(field, values) : undefined;
    if (value !== undefined) {
      documents[field.document][field.name] = value;
    }
  }
  return documents;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
A scalar as the control shows it; a value of another type renders empty.
*/
function scalar(field: FieldDescriptor, value: unknown): string {
  if (field.kind === 'boolean') {
    return value === true ? 'on' : '';
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function writeField(field: FieldDescriptor, value: unknown, values: Map<string, string>): void {
  switch (field.kind) {
    case 'lines': {
      values.set(fieldName(field), strings(value).join('\n'));
      return;
    }
    case 'set': {
      for (const option of strings(value)) {
        values.set(optionName(field, option), 'on');
      }
      return;
    }
    default: {
      values.set(fieldName(field), scalar(field, value));
    }
  }
}

/**
 * The form values of stored documents (the edit form, ACT-5). A document
 * that fails its schema (ACT-1) is shown as far as its shape allows, so the
 * operator can repair it: a field of the wrong type renders empty.
 */
export function valuesFromDocuments(
  form: ConnectorForm,
  documents: Readonly<Record<DocumentName, unknown>>,
): FormValues {
  const values = new Map<string, string>();
  for (const field of form.fields) {
    const document = documents[field.document];
    if (isRecord(document)) {
      writeField(field, document[field.name], values);
    }
  }
  return values;
}

/**
What a new target's form starts with: every descriptor's fallback.
*/
export function defaultValues(form: ConnectorForm): FormValues {
  const documents: Record<DocumentName, Record<string, unknown>> = {
    destination: {},
    credential: {},
    policy: {},
  };
  for (const field of form.fields) {
    if (field.kind !== 'text') {
      documents[field.document][field.name] = field.fallback;
    }
  }
  return valuesFromDocuments(form, documents);
}
