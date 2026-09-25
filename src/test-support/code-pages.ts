/**
 * The Semble connection pages under test (ACT-115, ACT-119, ACT-120): a vault
 * item holding a GitHub token twice (a stale one as its password, the live
 * one in a hidden custom field, as the live deployment keeps it), a fake
 * GitHub with one private and one public repository, the fake sidecar, and
 * the pages harness composed over the real `code` connector. Every token is a
 * canary, so a test can assert none reaches a page, a redirect or a log.
 */
import { createPagesHarness, type PagesHarness } from './actions-pages.ts';
import { createFakeSidecar, type FakeSidecar } from './fake-code-sidecar.ts';
import { createFakeGitHub, FAKE_TOKEN, type FakeGitHub, type FakeRepo } from './fake-github.ts';
import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { FIXTURE_ITEMS, type StoredItem } from './vault-fixture.ts';

import type { CodeControl, CodeIndexStatus } from '../actions/connectors/code/control.ts';

/**
A token GitHub no longer accepts, kept as the item's password.
*/
export const STALE_TOKEN = 'github_pat_CANARY_stale_fedcba9876543210';

export const PRIVATE_SHA = 'a'.repeat(40);
export const PUBLIC_SHA = 'b'.repeat(40);

export const PRIVATE_REPO: FakeRepo = {
  fullName: 'acme/private-app',
  defaultBranch: 'main',
  isPrivate: true,
  refs: { main: PRIVATE_SHA },
  archives: { [PRIVATE_SHA]: Buffer.from('a gzip tar of the private app', 'utf8') },
};

export const PUBLIC_REPO: FakeRepo = {
  fullName: 'acme/docs',
  defaultBranch: 'trunk',
  isPrivate: false,
  refs: { trunk: PUBLIC_SHA },
  archives: { [PUBLIC_SHA]: Buffer.from('a gzip tar of the docs', 'utf8') },
};

export const GITHUB_ITEM_ID = 'item-github';

export const GITHUB_ITEM: StoredItem = {
  summary: {
    id: GITHUB_ITEM_ID,
    name: 'GitHub bot',
    type: 'login',
    folderId: null,
    organizationId: null,
    collectionIds: [],
    favorite: false,
    revisionDate: '2026-09-01T09:00:00.000Z',
    deletedDate: null,
    login: {
      username: 'vaultgate-bot',
      uris: ['https://github.com'],
      hasPassword: true,
      hasTotp: false,
    },
    hasNotes: false,
    customFields: [{ name: 'AccessToken', kind: 'hidden', value: null }],
  },
  secrets: { password: STALE_TOKEN, hiddenFields: { AccessToken: FAKE_TOKEN } },
};

/**
An item that claims a password the vault then fails to read (a `getSecret` fault).
*/
export const BROKEN_ITEM: StoredItem = {
  summary: { ...GITHUB_ITEM.summary, id: 'item-broken', name: 'Broken GitHub bot' },
  secrets: {},
};

export interface CodePages {
  readonly harness: PagesHarness;
  readonly github: FakeGitHub;
  readonly sidecar: FakeSidecar;
  readonly vault: InMemoryVaultClient;
}

export interface CodePagesOptions {
  readonly addresses?: Readonly<Record<string, readonly string[]>>;
  readonly apiStatus?: number;
  /**
  `false` composes the pages with the code connector off (`engine.code` undefined).
  */
  readonly connector?: boolean;
  readonly codeControl?: CodeControl;
}

export function createCodePages(options: CodePagesOptions = {}): CodePages {
  const github = createFakeGitHub({
    repos: [PRIVATE_REPO, PUBLIC_REPO],
    ...(options.apiStatus !== undefined && { apiStatus: options.apiStatus }),
  });
  const sidecar = createFakeSidecar();
  const vault = new InMemoryVaultClient([...FIXTURE_ITEMS, GITHUB_ITEM, BROKEN_ITEM]);
  const harness = createPagesHarness({
    vault,
    github,
    ...(options.connector !== false && { code: { sidecar, github } }),
    ...(options.addresses !== undefined && { addresses: options.addresses }),
    ...(options.codeControl !== undefined && { codeControl: options.codeControl }),
  });
  return { harness, github, sidecar, vault };
}

/**
A code target as the create form posts it, reading the private repository with the hidden field.
*/
export const CODE_FORM: Readonly<Record<string, string>> = {
  connector: 'code',
  name: 'app-code',
  description: 'The private app, for code search',
  'credential.item_id': GITHUB_ITEM_ID,
  'destination.repository': PRIVATE_REPO.fullName,
  'destination.ref': '',
  'credential.token_field': 'custom.AccessToken',
  'policy.content.code': 'on',
  'policy.content.docs': 'on',
  'policy.content.config': 'on',
  'policy.allow_read': 'on',
  'policy.allow_ref': 'on',
  'policy.timeout_ms': '150000',
};

export const EMPTY_STATUS: CodeIndexStatus = {
  reachable: true,
  snapshots: [],
  building: false,
  resolution: undefined,
  lastBuild: undefined,
  lastFailure: undefined,
};

export interface StubControl extends CodeControl {
  readonly refreshed: {
    readonly targetId: string;
    readonly trigger: string;
    readonly isReset: boolean;
  }[];
}

/**
A `CodeControl` that answers `status` and records `refresh`, which rejects when told to.
*/
export function stubControl(status: CodeIndexStatus, isRefreshFailing = false): StubControl {
  const refreshed: StubControl['refreshed'] = [];
  return {
    refreshed,
    status: () => Promise.resolve(status),
    refresh(targetId, trigger, isReset) {
      refreshed.push({ targetId, trigger, isReset });
      return isRefreshFailing ? Promise.reject(new Error('the build blew up')) : Promise.resolve();
    },
    forgetTarget: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
  };
}
