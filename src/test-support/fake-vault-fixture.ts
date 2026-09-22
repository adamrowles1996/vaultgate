/**
 * The in-memory vault behind the fake `bw serve`: one item of every type
 * (VAULT-13) and one custom field of every kind. Every secret value is a
 * canary string so a test can assert that none of them leaks through a
 * summary, a log line or an error message (ARCH-4, VAULT-14).
 */
export const CANARY = {
  password: 'CANARY-PASSWORD-7f3a',
  totpSeed: 'JBSWY3DPEHPK3PXP',
  notes: 'CANARY-NOTES-1c9e',
  hiddenField: 'CANARY-HIDDEN-52b1',
  cardNumber: 'CANARY-CARD-4111',
  cardCode: 'CANARY-CVV-731',
  identityPassport: 'CANARY-PASSPORT-9a2f',
  sshPrivateKey: 'CANARY-SSH-PRIVATE-0e4d',
  masterPassword: 'CANARY-MASTER-PASSWORD',
  sessionKey: 'CANARY-SESSION-KEY',
} as const;

export const FIXTURE_IDS = {
  login: '11111111-1111-4111-8111-111111111111',
  secureNote: '22222222-2222-4222-8222-222222222222',
  card: '33333333-3333-4333-8333-333333333333',
  identity: '44444444-4444-4444-8444-444444444444',
  sshKey: '55555555-5555-4555-8555-555555555555',
  trashedLogin: '66666666-6666-4666-8666-666666666666',
  folder: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  collection: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organization: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

export const FIXTURE_REVISION = '2026-09-01T09:00:00.000Z';

export type FixtureItem = Record<string, unknown>;

function base(id: string, name: string, type: number): FixtureItem {
  return {
    object: 'item',
    id,
    organizationId: null,
    folderId: null,
    type,
    reprompt: 0,
    name,
    notes: null,
    favorite: false,
    collectionIds: [],
    revisionDate: FIXTURE_REVISION,
    creationDate: FIXTURE_REVISION,
    deletedDate: null,
  };
}

export function fixtureItems(): FixtureItem[] {
  return [
    {
      ...base(FIXTURE_IDS.login, 'Example login', 1),
      folderId: FIXTURE_IDS.folder,
      favorite: true,
      notes: CANARY.notes,
      login: {
        username: 'alice',
        password: CANARY.password,
        totp: CANARY.totpSeed,
        uris: [
          { match: null, uri: 'https://example.com/login' },
          { match: null, uri: null },
        ],
        passwordRevisionDate: null,
      },
      fields: [
        { name: 'environment', value: 'production', type: 0, linkedId: null },
        { name: 'api-key', value: CANARY.hiddenField, type: 1, linkedId: null },
        { name: 'mfa', value: 'true', type: 2, linkedId: null },
        { name: 'linked', value: null, type: 3, linkedId: 100 },
      ],
    },
    {
      ...base(FIXTURE_IDS.secureNote, 'Example note', 2),
      notes: CANARY.notes,
      secureNote: { type: 0 },
    },
    {
      ...base(FIXTURE_IDS.card, 'Example card', 3),
      card: {
        cardholderName: 'Alice Example',
        brand: 'Visa',
        number: CANARY.cardNumber,
        expMonth: '12',
        expYear: '2030',
        code: CANARY.cardCode,
      },
    },
    {
      ...base(FIXTURE_IDS.identity, 'Example identity', 4),
      identity: {
        firstName: 'Alice',
        lastName: 'Example',
        passportNumber: CANARY.identityPassport,
        email: 'alice@example.com',
        username: null,
      },
    },
    {
      ...base(FIXTURE_IDS.sshKey, 'Example ssh key', 5),
      sshKey: {
        privateKey: CANARY.sshPrivateKey,
        publicKey: 'ssh-ed25519 AAAA public',
        keyFingerprint: 'SHA256:fingerprint',
      },
    },
    {
      ...base(FIXTURE_IDS.trashedLogin, 'Old login', 1),
      organizationId: FIXTURE_IDS.organization,
      collectionIds: [FIXTURE_IDS.collection],
      deletedDate: '2026-09-10T12:00:00.000Z',
      login: { username: 'bob', password: CANARY.password, totp: null, uris: [] },
    },
  ];
}

export function fixtureFolders(): { id: string; name: string }[] {
  return [{ id: FIXTURE_IDS.folder, name: 'Work' }];
}

export function fixtureCollections(): { id: string; name: string; organizationId: string }[] {
  return [{ id: FIXTURE_IDS.collection, name: 'Shared', organizationId: FIXTURE_IDS.organization }];
}
