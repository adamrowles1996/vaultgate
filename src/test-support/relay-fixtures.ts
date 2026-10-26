/**
 * A vault for the credential relay's tests (spec §15): every item has a UUID,
 * as Bitwarden's do, and the scope is one collection plus one listed item.
 * Items outside the scope carry their own canary, which no relay answer may
 * ever contain (RELAY-4).
 */
import { createRelayApp, type RelayApp } from '../relay/app.ts';
import { createScope, type RelayScope } from '../relay/scope.ts';
import { createRelaySync, type RequestSync } from '../relay/sync.ts';

import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { captureLogger } from './logging.ts';

import type { StoredItem } from './vault-fixture.ts';
import type { AuditEvent, AuditSink } from '../audit/event.ts';
import type { TailnetPeer, WhoIs } from '../relay/whois.ts';
import type { ItemSummary } from '../vault/client.ts';

export const SCOPED_COLLECTION = '5d0c7a1e-0000-4000-8000-00000000c001';
const OTHER_COLLECTION = '5d0c7a1e-0000-4000-8000-00000000c002';

export const RELAY_ID = {
  database: '0f6b2d3c-0000-4000-8000-000000000001',
  note: '0f6b2d3c-0000-4000-8000-000000000002',
  outside: '0f6b2d3c-0000-4000-8000-000000000003',
  trashed: '0f6b2d3c-0000-4000-8000-000000000004',
  card: '0f6b2d3c-0000-4000-8000-000000000005',
  mailer: '0f6b2d3c-0000-4000-8000-000000000006',
  mailerBackup: '0f6b2d3c-0000-4000-8000-000000000007',
  twin: '0f6b2d3c-0000-4000-8000-000000000008',
  twinCopy: '0f6b2d3c-0000-4000-8000-000000000009',
  slashed: '0f6b2d3c-0000-4000-8000-00000000000a',
} as const;

export const RELAY_SECRET = {
  password: 'RELAY-PASSWORD-7e21',
  notes: 'RELAY-NOTES-55b0',
  hidden: 'RELAY-HIDDEN-0c9d',
  noteBody: 'RELAY-NOTE-BODY-41aa',
  totpSeed: 'RELAY-TOTP-SEED-never-answered',
  outside: 'RELAY-OUTSIDE-SCOPE-9f9f',
} as const;

export const LISTEN = { host: '100.64.0.10', port: 8087 } as const;
export const RELAY_HOST = '100.64.0.10:8087';
export const PEER_ADDRESS = '100.64.0.20';
export const PEER: TailnetPeer = {
  node: 'sandbox-1.example.ts.net',
  tags: ['tag:sandbox'],
  addresses: [PEER_ADDRESS, 'fd7a:115c:a1e0::20'],
  routes: false,
};

export function summary(
  id: string,
  name: string,
  overrides: Partial<ItemSummary> = {},
): ItemSummary {
  return {
    id,
    name,
    type: 'login',
    folderId: null,
    organizationId: '5d0c7a1e-0000-4000-8000-00000000e001',
    collectionIds: [SCOPED_COLLECTION],
    favorite: false,
    revisionDate: '2026-10-01T09:00:00.000Z',
    deletedDate: null,
    login: { username: 'svc_reader', uris: [], hasPassword: true, hasTotp: false },
    hasNotes: false,
    customFields: [],
    ...overrides,
  };
}

export const RELAY_ITEMS: readonly StoredItem[] = [
  {
    summary: summary(RELAY_ID.database, 'Reporting database', {
      login: {
        username: 'report_reader',
        uris: ['postgres://db.internal:5432/reporting'],
        hasPassword: true,
        hasTotp: true,
      },
      hasNotes: true,
      customFields: [
        { name: 'Host', kind: 'text', value: 'db.internal' },
        { name: 'Api key', kind: 'hidden', value: null },
        { name: 'Read only', kind: 'boolean', value: 'true' },
        { name: 'Linked user', kind: 'linked', value: null },
      ],
    }),
    secrets: {
      password: RELAY_SECRET.password,
      notes: RELAY_SECRET.notes,
      totpSeed: RELAY_SECRET.totpSeed,
      hiddenFields: { 'Api key': RELAY_SECRET.hidden },
    },
  },
  {
    summary: summary(RELAY_ID.note, 'Deploy key', {
      type: 'secureNote',
      collectionIds: [],
      login: null,
      hasNotes: true,
    }),
    secrets: { notes: RELAY_SECRET.noteBody },
  },
  {
    summary: summary(RELAY_ID.outside, 'Payroll database', { collectionIds: [OTHER_COLLECTION] }),
    secrets: { password: RELAY_SECRET.outside },
  },
  {
    summary: summary(RELAY_ID.trashed, 'Retired database', {
      deletedDate: '2026-09-30T00:00:00.000Z',
    }),
    secrets: { password: RELAY_SECRET.outside },
  },
  {
    summary: summary(RELAY_ID.card, 'Company card', { type: 'card', login: null }),
    secrets: { card: { number: RELAY_SECRET.outside, code: RELAY_SECRET.outside } },
  },
  { summary: summary(RELAY_ID.mailer, 'Mailer'), secrets: { password: 'mailer-password' } },
  {
    summary: summary(RELAY_ID.mailerBackup, 'Mailer backup'),
    secrets: { password: 'mailer-backup-password' },
  },
  { summary: summary(RELAY_ID.twin, 'Twin'), secrets: { password: 'twin-one' } },
  { summary: summary(RELAY_ID.twinCopy, 'twin'), secrets: { password: 'twin-two' } },
  {
    summary: summary(RELAY_ID.slashed, 'f/ops/api key'),
    secrets: { password: 'slashed-password' },
  },
];

export function relayVault(): InMemoryVaultClient {
  return new InMemoryVaultClient(RELAY_ITEMS);
}

export function relayScope(): RelayScope {
  return createScope([SCOPED_COLLECTION.toUpperCase()], [RELAY_ID.note]);
}

export class RecordingSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

export interface RelayHarness {
  readonly app: RelayApp;
  readonly vault: InMemoryVaultClient;
  readonly audit: RecordingSink;
  readonly logged: () => string;
  /**
  Moves the injected clock, for the rate limit.
  */
  readonly advance: (ms: number) => void;
}

export interface RelayHarnessOptions {
  readonly whoIs?: WhoIs;
  /**
  The operator's sync `/sync` asks for; the in-memory vault's own by default.
  */
  readonly requestSync?: RequestSync;
  readonly peerAddress?: string | undefined;
  readonly listen?: { readonly host: string; readonly port: number };
}

export function relayHarness(options: RelayHarnessOptions = {}): RelayHarness {
  const vault = relayVault();
  const audit = new RecordingSink();
  const { logger, lines } = captureLogger();
  let nowMs = Date.parse('2026-10-14T12:00:00.000Z');
  const address = 'peerAddress' in options ? options.peerAddress : PEER_ADDRESS;
  const app = createRelayApp({
    listen: options.listen ?? LISTEN,
    tags: ['tag:sandbox'],
    scope: relayScope(),
    whoIs: options.whoIs ?? (() => Promise.resolve(PEER)),
    peerAddress: () => address,
    vault,
    sync: createRelaySync(options.requestSync ?? (() => vault.sync()), () => nowMs),
    audit,
    logger,
    now: () => nowMs,
  });
  return {
    app,
    vault,
    audit,
    logged: () => JSON.stringify(lines()),
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

/**
A request to the harness as a `bw serve` client sends it: the listener's `Host`, no `Origin`.
*/
export function relayGet(
  harness: RelayHarness,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return Promise.resolve(harness.app.request(path, { headers: { host: RELAY_HOST, ...headers } }));
}

/**
The status `relayGet` receives.
*/
export async function relayStatus(
  harness: RelayHarness,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<number> {
  const response = await relayGet(harness, path, headers);
  return response.status;
}

/**
The body `relayGet` receives, as text.
*/
export async function relayText(harness: RelayHarness, path: string): Promise<string> {
  const response = await relayGet(harness, path);
  return response.text();
}
