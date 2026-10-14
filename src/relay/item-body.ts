/**
 * The values the relay answers (RELAY-5, RELAY-7), assembled from the
 * `VaultClient` contract alone: the summary carries everything but the
 * secrets, and each secret comes from `getSecret`, the one path that reads
 * secret material. Bodies follow `bw serve`'s item JSON for the fields
 * vaultgate models, so a client written for `bw serve` reads them
 * unchanged. A TOTP seed is never part of a body: `login.totp` is always
 * null and the current code is answered on its own route.
 */
import { fail, ok, type Result } from '../result.ts';

import type {
  ItemSummary,
  SecretField,
  VaultClient,
  VaultError,
  VaultResult,
} from '../vault/client.ts';

export type ItemBody = Readonly<Record<string, unknown>>;

/**
The scalar routes of `bw serve` the relay answers (RELAY-5).
*/
export const SCALAR_KINDS = ['username', 'password', 'notes', 'totp', 'uri'] as const;

export type ScalarKind = (typeof SCALAR_KINDS)[number];

const ITEM_TYPE = { login: 1, secureNote: 2 } as const;
const FIELD_TYPE = { text: 0, hidden: 1, boolean: 2, linked: 3 } as const;

/**
Failures that mean the item holds no such value, which is an answer here, not an error.
*/
const ABSENT: ReadonlySet<VaultError['code']> = new Set(['not_found', 'invalid_item']);

/**
A secret's text, or `null` when the item holds none.
*/
async function secretText(
  vault: VaultClient,
  id: string,
  field: SecretField,
): Promise<Result<string | null, VaultError>> {
  const secret = await vault.getSecret(id, field);
  if (!secret.ok) {
    return ABSENT.has(secret.error.code) ? ok(null) : secret;
  }
  return ok(secret.value.kind === 'totp' ? secret.value.code : secret.value.value);
}

async function revealedFields(
  vault: VaultClient,
  item: ItemSummary,
): Promise<Result<readonly ItemBody[], VaultError>> {
  const fields: ItemBody[] = [];
  for (const field of item.customFields) {
    let value = field.value;
    if (field.kind === 'hidden') {
      const hidden = await secretText(vault, item.id, { kind: 'customField', name: field.name });
      if (!hidden.ok) {
        return hidden;
      }
      value = hidden.value;
    }
    fields.push({ name: field.name, value, type: FIELD_TYPE[field.kind], linkedId: null });
  }
  return ok(fields);
}

function typeBody(item: ItemSummary, password: string | null): ItemBody {
  if (item.login === null) {
    return { secureNote: { type: 0 } };
  }
  return {
    login: {
      uris: item.login.uris.map((uri) => ({ match: null, uri })),
      username: item.login.username,
      password,
      totp: null,
      passwordRevisionDate: null,
      fido2Credentials: [],
    },
  };
}

/**
RELAY-7: the item as `bw serve` would answer it, secrets included except the TOTP seed.
*/
export async function revealItem(vault: VaultClient, item: ItemSummary): VaultResult<ItemBody> {
  const password =
    item.login?.hasPassword === true
      ? await secretText(vault, item.id, { kind: 'password' })
      : ok(null);
  if (!password.ok) {
    return password;
  }
  const notes = item.hasNotes ? await secretText(vault, item.id, { kind: 'notes' }) : ok(null);
  if (!notes.ok) {
    return notes;
  }
  const fields = await revealedFields(vault, item);
  if (!fields.ok) {
    return fields;
  }
  return ok({
    object: 'item',
    id: item.id,
    organizationId: item.organizationId,
    folderId: item.folderId,
    type: item.type === 'login' ? ITEM_TYPE.login : ITEM_TYPE.secureNote,
    reprompt: 0,
    name: item.name,
    notes: notes.value,
    favorite: item.favorite,
    fields: fields.value,
    ...typeBody(item, password.value),
    collectionIds: item.collectionIds,
    revisionDate: item.revisionDate,
    deletedDate: null,
    passwordHistory: null,
  });
}

/**
 * One scalar of an item, or the empty string when the item holds none: an
 * empty value is what a `bw serve` client reads as "no value", which is the
 * answer, not a missing item.
 */
export async function revealScalar(
  vault: VaultClient,
  item: ItemSummary,
  kind: ScalarKind,
): VaultResult<string> {
  switch (kind) {
    case 'username': {
      return ok(item.login?.username ?? '');
    }
    case 'uri': {
      return ok(item.login?.uris[0] ?? '');
    }
    case 'totp': {
      return item.login?.hasTotp === true ? scalar(vault, item.id, { kind: 'totp' }) : ok('');
    }
    default: {
      return scalar(vault, item.id, { kind });
    }
  }
}

async function scalar(vault: VaultClient, id: string, field: SecretField): VaultResult<string> {
  const text = await secretText(vault, id, field);
  return text.ok ? ok(text.value ?? '') : fail(text.error);
}
