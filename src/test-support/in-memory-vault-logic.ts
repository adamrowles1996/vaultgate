import type { ItemSecrets } from './vault-fixture.ts';
import type {
  CustomFieldSummary,
  ItemPatch,
  ItemSummary,
  NewItem,
  SearchQuery,
  SecretField,
  SecretValue,
} from '../vault/client.ts';

export const FIXED_NOW = '2026-09-22T10:00:00.000Z';
const TOTP_PERIOD_SECONDS = 30;

type Predicate = (summary: ItemSummary) => boolean;

function isTextMatch(summary: ItemSummary, needle: string): boolean {
  const haystack = [summary.name, summary.login?.username ?? '', ...(summary.login?.uris ?? [])];
  return haystack.some((value) => value.toLowerCase().includes(needle.toLowerCase()));
}

export function predicatesFor(query: SearchQuery): readonly Predicate[] {
  const predicates: Predicate[] = [];
  if (query.text !== undefined) {
    const text = query.text;
    predicates.push((summary) => isTextMatch(summary, text));
  }
  if (query.type !== undefined) {
    const type = query.type;
    predicates.push((summary) => summary.type === type);
  }
  if (query.folderId !== undefined) {
    const folderId = query.folderId;
    predicates.push((summary) => summary.folderId === folderId);
  }
  if (query.collectionId !== undefined) {
    const collectionId = query.collectionId;
    predicates.push((summary) => summary.collectionIds.includes(collectionId));
  }
  if (query.url !== undefined) {
    const url = query.url;
    predicates.push((summary) => summary.login?.uris.some((uri) => uri.includes(url)) ?? false);
  }
  if (query.includeTrash !== true) {
    predicates.push((summary) => summary.deletedDate === null);
  }
  return predicates;
}

function text(value: string | undefined): SecretValue | undefined {
  return value === undefined ? undefined : { kind: 'text', value };
}

const SECRET_LOOKUPS: {
  readonly [K in SecretField['kind']]: (
    secrets: ItemSecrets,
    field: Extract<SecretField, { kind: K }>,
  ) => SecretValue | undefined;
} = {
  password: (secrets) => text(secrets.password),
  totp: (secrets) =>
    secrets.totpSeed === undefined
      ? undefined
      : { kind: 'totp', code: '123456', secondsRemaining: TOTP_PERIOD_SECONDS },
  notes: (secrets) => text(secrets.notes),
  card: (secrets, field) => text(secrets.card?.[field.field]),
  identity: (secrets, field) => text(secrets.identity?.[field.field]),
  sshKey: (secrets) => text(secrets.sshPrivateKey),
  customField: (secrets, field) => text(secrets.hiddenFields?.[field.name]),
};

export function secretLookup(secrets: ItemSecrets, field: SecretField): SecretValue | undefined {
  switch (field.kind) {
    case 'password': {
      return SECRET_LOOKUPS.password(secrets, field);
    }
    case 'totp': {
      return SECRET_LOOKUPS.totp(secrets, field);
    }
    case 'notes': {
      return SECRET_LOOKUPS.notes(secrets, field);
    }
    case 'card': {
      return SECRET_LOOKUPS.card(secrets, field);
    }
    case 'identity': {
      return SECRET_LOOKUPS.identity(secrets, field);
    }
    case 'sshKey': {
      return SECRET_LOOKUPS.sshKey(secrets, field);
    }
    case 'customField': {
      return SECRET_LOOKUPS.customField(secrets, field);
    }
  }
}

function writtenFields(patch: ItemPatch): Readonly<Record<string, string>> {
  return Object.fromEntries((patch.customFields ?? []).map((field) => [field.name, field.value]));
}

export function mergedSecrets(existing: ItemSecrets, patch: ItemPatch): ItemSecrets {
  return {
    ...existing,
    ...(patch.login?.password !== undefined && { password: patch.login.password }),
    ...(patch.notes !== undefined && { notes: patch.notes }),
    ...(patch.customFields !== undefined && {
      hiddenFields: { ...existing.hiddenFields, ...writtenFields(patch) },
    }),
  };
}

/**
 * ACT-83: a custom field the item does not carry is created `hidden`. A field
 * it already carries keeps its summary entry: a hidden value never appears in
 * a summary, and only the stored secret changes.
 */
export function mergedCustomFields(
  existing: readonly CustomFieldSummary[],
  patch: ItemPatch,
): readonly CustomFieldSummary[] {
  const names = new Set(existing.map((field) => field.name));
  const added = (patch.customFields ?? []).filter((field) => !names.has(field.name));
  return [
    ...existing,
    ...added.map((field) => ({ name: field.name, kind: 'hidden' as const, value: null })),
  ];
}

export function mergedLogin(
  existing: ItemSummary['login'],
  patch: ItemPatch,
  secrets: ItemSecrets,
): ItemSummary['login'] {
  return existing === null
    ? null
    : {
        ...existing,
        username: patch.login?.username ?? existing.username,
        uris: patch.login?.uris ?? existing.uris,
        hasPassword: secrets.password !== undefined,
      };
}

export function newLogin(item: NewItem, secrets: ItemSecrets): ItemSummary['login'] {
  return item.type === 'login'
    ? {
        username: item.login?.username ?? null,
        uris: item.login?.uris ?? [],
        hasPassword: secrets.password !== undefined,
        hasTotp: false,
      }
    : null;
}
