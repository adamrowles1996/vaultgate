/**
 * Custom-field edits (MCP-17): the plan both vault clients apply, so the
 * rules live in one place. A field is matched by its exact name, as
 * `get_secret`'s `custom.<name>` matches it. One edit names each field once;
 * a field it renames, removes or sets must be the only one of that name. A
 * renamed field keeps its kind and value; a set keeps the existing field's
 * kind, or creates the field, `hidden` unless the edit says otherwise. Kept
 * fields keep their order and new ones follow in the order given.
 */
import { fail, ok, type Result } from '../result.ts';

import {
  type CustomFieldEdits,
  type CustomFieldKind,
  type CustomFieldRename,
  type CustomFieldSet,
  VaultError,
} from './client.ts';

/**
An item's field as the plan sees it: its name and kind; the client's own record rides along.
*/
export interface ExistingField {
  readonly name: string;
  readonly kind: CustomFieldKind;
}

/**
 * One field of the edited item: an existing field kept with its value
 * (`keep`, under `name`, which a rename changes), or a field written with a
 * new value (`null` leaves it empty), which `replaces` an existing one or is
 * new.
 */
export type PlannedField<F extends ExistingField> =
  | { readonly keep: F; readonly name: string; readonly kind: CustomFieldKind }
  | {
      readonly replaces?: F;
      readonly name: string;
      readonly kind: CustomFieldKind;
      readonly value: string | null;
    };

type Planned<T> = Result<T, VaultError>;

function invalid(message: string): Planned<never> {
  return fail(new VaultError('invalid_item', message));
}

function namedTwice(edits: CustomFieldEdits): string | undefined {
  const names = [
    ...(edits.set ?? []).map((field) => field.name),
    ...(edits.rename ?? []).flatMap((rename) => [rename.from, rename.to]),
    ...(edits.remove ?? []),
  ];
  return names.find((name, index) => names.indexOf(name) !== index);
}

function storedValue(name: string, kind: CustomFieldKind, value: string): Planned<string | null> {
  if (kind === 'linked') {
    return invalid(`custom field '${name}' is linked to another field and holds no value`);
  }
  if (kind === 'boolean' && value !== 'true' && value !== 'false') {
    return invalid(`custom field '${name}' is boolean: its value must be 'true' or 'false'`);
  }
  return ok(value.length === 0 ? null : value);
}

function eachOf<T>(items: readonly T[], step: (item: T) => Planned<void>): Planned<void> {
  for (const item of items) {
    const done = step(item);
    if (!done.ok) {
      return done;
    }
  }
  return ok(undefined);
}

interface Match<F> {
  readonly index: number;
  readonly field: F;
}

/**
The item's fields as the edit goes: one slot per existing field (empty once removed), then new ones.
*/
class FieldPlan<F extends ExistingField> {
  readonly #existing: readonly F[];
  readonly #slots: (PlannedField<F> | undefined)[];

  constructor(existing: readonly F[]) {
    this.#existing = existing;
    this.#slots = existing.map((field) => ({ keep: field, name: field.name, kind: field.kind }));
  }

  /**
  The one field called `name`, `undefined` when there is none.
  */
  #only(name: string): Planned<Match<F> | undefined> {
    const matches = this.#existing.flatMap((field, index) =>
      field.name === name ? [{ index, field }] : [],
    );
    return matches.length > 1
      ? invalid(`the item has ${String(matches.length)} custom fields named '${name}'`)
      : ok(matches[0]);
  }

  #required(name: string): Planned<Match<F>> {
    const found = this.#only(name);
    if (!found.ok) {
      return found;
    }
    return found.value === undefined
      ? invalid(`the item has no custom field named '${name}'`)
      : ok(found.value);
  }

  remove(name: string): Planned<void> {
    const match = this.#required(name);
    if (!match.ok) {
      return match;
    }
    this.#slots[match.value.index] = undefined;
    return ok(undefined);
  }

  rename({ from, to }: CustomFieldRename): Planned<void> {
    const match = this.#required(from);
    if (!match.ok) {
      return match;
    }
    if (this.#existing.some((field) => field.name === to)) {
      return invalid(`the item already has a custom field named '${to}'`);
    }
    const { index, field } = match.value;
    this.#slots[index] = { keep: field, name: to, kind: field.kind };
    return ok(undefined);
  }

  set(set: CustomFieldSet): Planned<void> {
    const found = this.#only(set.name);
    if (!found.ok) {
      return found;
    }
    const match = found.value;
    const kind = match?.field.kind ?? set.kind ?? 'hidden';
    if (set.kind !== undefined && set.kind !== kind) {
      return invalid(
        `custom field '${set.name}' is ${kind}, not ${set.kind}; remove it and set it again to change its kind`,
      );
    }
    const value = storedValue(set.name, kind, set.value);
    if (!value.ok) {
      return value;
    }
    if (match === undefined) {
      this.#slots.push({ name: set.name, kind, value: value.value });
    } else {
      this.#slots[match.index] = {
        replaces: match.field,
        name: set.name,
        kind,
        value: value.value,
      };
    }
    return ok(undefined);
  }

  fields(): readonly PlannedField<F>[] {
    return this.#slots.filter((slot) => slot !== undefined);
  }
}

/**
The item's fields after `edits`, or why the edit cannot apply; nothing is half-applied.
*/
export function planFieldEdits<F extends ExistingField>(
  existing: readonly F[],
  edits: CustomFieldEdits,
): Planned<readonly PlannedField<F>[]> {
  const repeated = namedTwice(edits);
  if (repeated !== undefined) {
    return invalid(`custom field '${repeated}' is named by more than one change`);
  }
  const plan = new FieldPlan(existing);
  const removed = eachOf(edits.remove ?? [], (name) => plan.remove(name));
  const renamed = removed.ok
    ? eachOf(edits.rename ?? [], (rename) => plan.rename(rename))
    : removed;
  const written = renamed.ok ? eachOf(edits.set ?? [], (set) => plan.set(set)) : renamed;
  return written.ok ? ok(plan.fields()) : written;
}
