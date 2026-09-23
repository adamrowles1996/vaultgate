/**
 * Translation between `bw serve` item JSON and the vault contract: summaries
 * strip every secret value (VAULT-13), write bodies carry only what the
 * contract allows, and secret reads pick one field from a raw item.
 */
import { FIELD_TYPES, ITEM_TYPES, type RawField, type RawItem } from './types.ts';

import type {
  CustomFieldKind,
  CustomFieldPatch,
  CustomFieldSummary,
  ItemPatch,
  ItemSummary,
  ItemType,
  LoginSummary,
  NewItem,
  SecretField,
} from '../vault/client.ts';

const ITEM_TYPE_NAMES: Readonly<Record<RawItem['type'], ItemType>> = {
  [ITEM_TYPES.login]: 'login',
  [ITEM_TYPES.secureNote]: 'secureNote',
  [ITEM_TYPES.card]: 'card',
  [ITEM_TYPES.identity]: 'identity',
  [ITEM_TYPES.sshKey]: 'sshKey',
};

const FIELD_KIND_NAMES: Readonly<Record<RawField['type'], CustomFieldKind>> = {
  [FIELD_TYPES.text]: 'text',
  [FIELD_TYPES.hidden]: 'hidden',
  [FIELD_TYPES.boolean]: 'boolean',
  [FIELD_TYPES.linked]: 'linked',
};

const SECURE_NOTE_GENERIC = 0;

function isPresent(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

function summariseField(field: RawField): CustomFieldSummary {
  const kind = FIELD_KIND_NAMES[field.type];
  const hasVisibleValue = kind === 'text' || kind === 'boolean';
  return {
    name: field.name ?? '',
    kind,
    value: hasVisibleValue && isPresent(field.value) ? field.value : null,
  };
}

export function itemTypeOf(raw: RawItem): ItemType {
  return ITEM_TYPE_NAMES[raw.type];
}

function summariseLogin(login: NonNullable<RawItem['login']>): LoginSummary {
  return {
    username: login.username ?? null,
    uris: (login.uris ?? []).map((entry) => entry.uri).filter((uri) => isPresent(uri)),
    hasPassword: isPresent(login.password),
    hasTotp: isPresent(login.totp),
  };
}

/**
Everything about an item except its secret values.
*/
export function summariseItem(raw: RawItem): ItemSummary {
  return {
    id: raw.id,
    name: raw.name,
    type: itemTypeOf(raw),
    folderId: raw.folderId ?? null,
    organizationId: raw.organizationId ?? null,
    collectionIds: raw.collectionIds ?? [],
    favorite: raw.favorite ?? false,
    revisionDate: raw.revisionDate,
    deletedDate: raw.deletedDate ?? null,
    login: raw.login == null ? null : summariseLogin(raw.login),
    hasNotes: isPresent(raw.notes),
    customFields: (raw.fields ?? []).map((field) => summariseField(field)),
  };
}

function loginBody(login: NewItem['login']): Record<string, unknown> {
  return {
    username: login?.username ?? null,
    password: login?.password ?? null,
    totp: null,
    uris: (login?.uris ?? []).map((uri) => ({ match: null, uri })),
  };
}

/**
The `POST /object/item` body for a new login or secure note.
*/
export function newItemBody(item: NewItem): Record<string, unknown> {
  const shared = {
    organizationId: null,
    collectionIds: null,
    folderId: item.folderId ?? null,
    name: item.name,
    notes: item.notes ?? null,
    favorite: item.favorite ?? false,
    fields: [],
    reprompt: 0,
  };
  return item.type === 'login'
    ? { ...shared, type: ITEM_TYPES.login, login: loginBody(item.login) }
    : { ...shared, type: ITEM_TYPES.secureNote, secureNote: { type: SECURE_NOTE_GENERIC } };
}

function patchedLogin(raw: RawItem, login: ItemPatch['login']): Record<string, unknown> | null {
  if (login === undefined) {
    return raw.login ?? null;
  }
  const current = raw.login ?? {};
  return {
    ...current,
    username: login.username ?? current.username ?? null,
    password: login.password ?? current.password ?? null,
    uris: login.uris === undefined ? (current.uris ?? []) : login.uris.map((uri) => ({ uri })),
  };
}

/**
 * The item's custom fields with the patch applied (ACT-83): a named field
 * keeps its kind and takes the new value, a name the item does not carry is
 * appended as a `hidden` field.
 */
function patchedFields(raw: RawItem, patch: readonly CustomFieldPatch[]): readonly RawField[] {
  const existing = raw.fields ?? [];
  const written = new Map(patch.map((field) => [field.name, field.value]));
  // A `custom.<name>` selector always names a non-empty field, so an item
  // field the vault left unnamed can never be the one a patch means.
  const updated = existing.map((field) => {
    const value = written.get(field.name ?? '');
    return value === undefined ? field : { ...field, value };
  });
  const names = new Set(existing.map((field) => field.name ?? ''));
  return [
    ...updated,
    ...patch
      .filter((field) => !names.has(field.name))
      .map((field) => ({ name: field.name, value: field.value, type: FIELD_TYPES.hidden })),
  ];
}

/**
 * The `PUT /object/item/{id}` body: the raw item with the patch applied.
 * Fields vaultgate does not model pass through untouched.
 */
export function patchedItemBody(raw: RawItem, patch: ItemPatch): Record<string, unknown> {
  return {
    ...raw,
    name: patch.name ?? raw.name,
    folderId: patch.folderId === undefined ? (raw.folderId ?? null) : patch.folderId,
    notes: patch.notes ?? raw.notes ?? null,
    favorite: patch.favorite ?? raw.favorite ?? false,
    login: patchedLogin(raw, patch.login),
    ...(patch.customFields !== undefined && { fields: patchedFields(raw, patch.customFields) }),
  };
}

function presentOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function customField(raw: RawItem, name: string): string | undefined {
  const match = (raw.fields ?? []).find((field) => field.name === name);
  return presentOrUndefined(match?.value);
}

/**
 * Reads a secret held on the item body itself (card, identity, SSH key and
 * custom fields). Login password, TOTP and notes have dedicated endpoints and
 * are not read here. `undefined` means the field is absent or empty.
 */
export function secretFromItem(raw: RawItem, field: SecretField): string | undefined {
  switch (field.kind) {
    case 'card': {
      return presentOrUndefined(raw.card?.[field.field]);
    }
    case 'identity': {
      return presentOrUndefined(raw.identity?.[field.field]);
    }
    case 'sshKey': {
      return presentOrUndefined(raw.sshKey?.privateKey);
    }
    case 'customField': {
      return customField(raw, field.name);
    }
    default: {
      return undefined;
    }
  }
}
