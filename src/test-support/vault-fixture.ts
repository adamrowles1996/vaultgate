/**
 * A fixture vault covering every item type and custom-field kind, with an
 * unmistakable canary string in every secret position. Contract tests assert
 * that no canary ever appears outside a `get_secret` result (MCP-9).
 */
import type { CustomFieldSummary, ItemSummary, LoginSummary } from '../vault/client.ts';

export interface ItemSecrets {
  readonly password?: string;
  readonly totpSeed?: string;
  readonly notes?: string;
  readonly card?: { readonly number: string; readonly code: string };
  readonly identity?: Readonly<Record<string, string>>;
  readonly sshPrivateKey?: string;
  readonly hiddenFields?: Readonly<Record<string, string>>;
}

export interface StoredItem {
  readonly summary: ItemSummary;
  readonly secrets: ItemSecrets;
}

export const CANARY = {
  password: 'CANARY-PASSWORD-9f3c1a',
  totpSeed: 'CANARY-TOTP-SEED-3d9f',
  loginNotes: 'CANARY-LOGIN-NOTES-2b7e',
  secureNote: 'CANARY-SECURE-NOTE-BODY-51d0',
  cardNumber: 'CANARY-CARD-NUMBER-4111',
  cardCode: 'CANARY-CARD-CODE-737',
  identitySsn: 'CANARY-IDENTITY-SSN-0c4e',
  identityPassport: 'CANARY-IDENTITY-PASSPORT-88aa',
  sshPrivateKey: 'CANARY-SSH-PRIVATE-KEY-e6d2',
  hiddenField: 'CANARY-HIDDEN-FIELD-a1b2',
} as const;

export const CANARIES: readonly string[] = Object.values(CANARY);

export const FIXTURE_FOLDERS = [
  { id: 'folder-work', name: 'Work' },
  { id: 'folder-personal', name: 'Personal' },
] as const;

export const FIXTURE_COLLECTIONS = [
  { id: 'collection-infra', name: 'Infrastructure', organizationId: 'org-acme' },
] as const;

const REVISION = '2026-09-01T09:00:00.000Z';

const EXAMPLE_LOGIN: LoginSummary = {
  username: 'alice@example.com',
  uris: ['https://app.example.com/login'],
  hasPassword: true,
  hasTotp: true,
};

/**
One custom field of every kind (VAULT-13); only the hidden one has a secret value.
*/
const EXAMPLE_CUSTOM_FIELDS: readonly CustomFieldSummary[] = [
  { name: 'Environment', kind: 'text', value: 'production' },
  { name: 'API key', kind: 'hidden', value: null },
  { name: 'MFA enrolled', kind: 'boolean', value: 'true' },
  { name: 'Linked username', kind: 'linked', value: null },
];

function base(id: string, name: string, type: ItemSummary['type']): ItemSummary {
  return {
    id,
    name,
    type,
    folderId: null,
    organizationId: null,
    collectionIds: [],
    favorite: false,
    revisionDate: REVISION,
    deletedDate: null,
    login: null,
    hasNotes: false,
    customFields: [],
  };
}

export const FIXTURE_ITEMS: readonly StoredItem[] = [
  {
    summary: {
      ...base('item-login', 'Example Login', 'login'),
      folderId: 'folder-work',
      organizationId: 'org-acme',
      collectionIds: ['collection-infra'],
      favorite: true,
      login: EXAMPLE_LOGIN,
      hasNotes: true,
      customFields: EXAMPLE_CUSTOM_FIELDS,
    },
    secrets: {
      password: CANARY.password,
      totpSeed: CANARY.totpSeed,
      notes: CANARY.loginNotes,
      hiddenFields: { 'API key': CANARY.hiddenField },
    },
  },
  {
    summary: {
      ...base('item-note', 'Recovery Codes', 'secureNote'),
      folderId: 'folder-personal',
      hasNotes: true,
    },
    secrets: { notes: CANARY.secureNote },
  },
  {
    summary: base('item-card', 'Company Card', 'card'),
    secrets: { card: { number: CANARY.cardNumber, code: CANARY.cardCode } },
  },
  {
    summary: base('item-identity', 'Alice Identity', 'identity'),
    secrets: { identity: { ssn: CANARY.identitySsn, passportNumber: CANARY.identityPassport } },
  },
  {
    summary: base('item-ssh', 'Deploy Key', 'sshKey'),
    secrets: { sshPrivateKey: CANARY.sshPrivateKey },
  },
  {
    summary: {
      ...base('item-trashed', 'Old Login', 'login'),
      deletedDate: '2026-08-01T00:00:00.000Z',
      login: { username: 'old@example.com', uris: [], hasPassword: true, hasTotp: false },
    },
    secrets: { password: CANARY.password },
  },
];
