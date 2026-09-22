import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { CANARY, FIXTURE_IDS } from '../test-support/fake-vault-fixture.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { BwServeApi } from './api.ts';
import { BwServeVaultClient } from './vault-client.ts';

import type { SecretField } from '../vault/client.ts';

const ENDPOINT = 'http://127.0.0.1:4242';

interface ClientOptions {
  readonly serverUrl?: string;
  readonly isOffline?: boolean;
}

function clientFor(
  fake: FakeBwServe,
  { serverUrl, isOffline = false }: ClientOptions = {},
): { client: BwServeVaultClient; clock: ManualClock } {
  const clock = new ManualClock(Date.UTC(2026, 8, 22, 12, 0, 12));
  const api = new BwServeApi(() => (isOffline ? undefined : ENDPOINT), fake.fetch);
  const client = new BwServeVaultClient(
    serverUrl === undefined ? { api, clock } : { api, clock, serverUrl },
  );
  return { client, clock };
}

describe('BwServeVaultClient.status', () => {
  it('reports the masked account, lock state and last sync', async () => {
    const fake = new FakeBwServe();
    fake.lastSync = '2026-09-22T11:00:00.000Z';
    const { client } = clientFor(fake);
    expect(unwrapOk(await client.status())).toStrictEqual({
      serverUrl: 'https://vault.example.test',
      userEmailMasked: 'a***@example.com',
      state: 'unlocked',
      lastSyncAt: '2026-09-22T11:00:00.000Z',
    });
  });

  it('VAULT-5 reports unavailable with the configured server while bw serve is down', async () => {
    const { client } = clientFor(new FakeBwServe(), {
      serverUrl: 'https://self.example',
      isOffline: true,
    });
    expect(unwrapOk(await client.status())).toStrictEqual({
      serverUrl: 'https://self.example',
      userEmailMasked: null,
      state: 'unavailable',
      lastSyncAt: null,
    });
  });

  it('VAULT-12 fails on an unexpected status shape', async () => {
    const fake = new FakeBwServe();
    fake.override('GET', '/status', { success: true, data: { object: 'template', template: {} } });
    const { client } = clientFor(fake);
    expect(unwrapFail(await client.status()).code).toBe('vault_protocol_error');
  });
});

describe('BwServeVaultClient.sync', () => {
  it('posts /sync', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    expect(await client.sync()).toStrictEqual({ ok: true, value: undefined });
    expect(fake.requestsTo('/sync')).toHaveLength(1);
  });

  it('reports a locked vault as unavailable', async () => {
    const fake = new FakeBwServe({ state: 'locked' });
    const { client } = clientFor(fake);
    expect(unwrapFail(await client.sync()).code).toBe('vault_unavailable');
  });
});

describe('BwServeVaultClient.searchItems', () => {
  it('lists live items without secrets and applies the limit', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const all = unwrapOk(await client.searchItems({ limit: 50 }));
    expect(all.map((item) => item.type)).toStrictEqual([
      'login',
      'secureNote',
      'card',
      'identity',
      'sshKey',
    ]);
    const serialised = JSON.stringify(all);
    for (const canary of Object.values(CANARY)) {
      expect(serialised).not.toContain(canary);
    }
    expect(unwrapOk(await client.searchItems({ limit: 2 }))).toHaveLength(2);
  });

  it('passes text, folder, collection and url filters to bw serve', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const byText = unwrapOk(await client.searchItems({ text: 'LOGIN', limit: 50 }));
    expect(byText.map((item) => item.id)).toStrictEqual([FIXTURE_IDS.login]);
    const byFolder = unwrapOk(await client.searchItems({ folderId: FIXTURE_IDS.folder, limit: 5 }));
    expect(byFolder.map((item) => item.id)).toStrictEqual([FIXTURE_IDS.login]);
    const byUrl = unwrapOk(
      await client.searchItems({ url: 'https://example.com/login', limit: 5 }),
    );
    expect(byUrl.map((item) => item.id)).toStrictEqual([FIXTURE_IDS.login]);
    expect(fake.requests.map((request) => request.path)).toStrictEqual([
      '/list/object/items?search=LOGIN',
      `/list/object/items?folderid=${FIXTURE_IDS.folder}`,
      '/list/object/items?url=https%3A%2F%2Fexample.com%2Flogin',
    ]);
  });

  it('filters by item type locally', async () => {
    const { client } = clientFor(new FakeBwServe());
    const cards = unwrapOk(await client.searchItems({ type: 'card', limit: 50 }));
    expect(cards.map((item) => item.id)).toStrictEqual([FIXTURE_IDS.card]);
  });

  it('includes the bin only when asked', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const withTrash = unwrapOk(
      await client.searchItems({
        collectionId: FIXTURE_IDS.collection,
        includeTrash: true,
        limit: 50,
      }),
    );
    expect(withTrash.map((item) => item.id)).toStrictEqual([FIXTURE_IDS.trashedLogin]);
    expect(fake.requests.map((request) => request.path)).toStrictEqual([
      `/list/object/items?collectionid=${FIXTURE_IDS.collection}`,
      `/list/object/items?collectionid=${FIXTURE_IDS.collection}&trash=true`,
    ]);
  });

  it('propagates a failure from either listing', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    fake.override('GET', '/list/object/items?trash=true', 'not json');
    expect(unwrapOk(await client.searchItems({ limit: 5 }))).toHaveLength(5);
    expect(unwrapFail(await client.searchItems({ includeTrash: true, limit: 5 })).code).toBe(
      'vault_protocol_error',
    );
    fake.override('GET', '/list/object/items', 'not json');
    expect(unwrapFail(await client.searchItems({ limit: 5 })).code).toBe('vault_protocol_error');
  });
});

describe('BwServeVaultClient.getItem', () => {
  it('returns the summary or not_found', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapOk(await client.getItem(FIXTURE_IDS.secureNote)).name).toBe('Example note');
    expect(unwrapFail(await client.getItem('missing')).code).toBe('not_found');
  });
});

describe('BwServeVaultClient.getSecret', () => {
  const cases: readonly [SecretField, string][] = [
    [{ kind: 'password' }, CANARY.password],
    [{ kind: 'notes' }, CANARY.notes],
    [{ kind: 'customField', name: 'api-key' }, CANARY.hiddenField],
  ];

  it('reads password, notes and hidden custom fields of a login', async () => {
    const { client } = clientFor(new FakeBwServe());
    for (const [field, expected] of cases) {
      expect(unwrapOk(await client.getSecret(FIXTURE_IDS.login, field))).toStrictEqual({
        kind: 'text',
        value: expected,
      });
    }
  });

  it('reads card, identity and ssh key fields', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(
      unwrapOk(await client.getSecret(FIXTURE_IDS.card, { kind: 'card', field: 'code' })),
    ).toStrictEqual({ kind: 'text', value: CANARY.cardCode });
    expect(
      unwrapOk(
        await client.getSecret(FIXTURE_IDS.identity, { kind: 'identity', field: 'passportNumber' }),
      ),
    ).toStrictEqual({ kind: 'text', value: CANARY.identityPassport });
    expect(
      unwrapOk(await client.getSecret(FIXTURE_IDS.sshKey, { kind: 'sshKey', field: 'privateKey' })),
    ).toStrictEqual({ kind: 'text', value: CANARY.sshPrivateKey });
  });

  it('MCP-11 returns the current TOTP code with its remaining validity, never the seed', async () => {
    const fake = new FakeBwServe();
    const { client, clock } = clientFor(fake);
    const totp = unwrapOk(await client.getSecret(FIXTURE_IDS.login, { kind: 'totp' }));
    expect(totp).toStrictEqual({ kind: 'totp', code: '123456', secondsRemaining: 18 });
    await clock.advance(17_000);
    const later = unwrapOk(await client.getSecret(FIXTURE_IDS.login, { kind: 'totp' }));
    expect(later).toStrictEqual({ kind: 'totp', code: '123456', secondsRemaining: 1 });
    expect(fake.requestsTo(`/object/totp/${FIXTURE_IDS.login}`)).toHaveLength(2);
  });

  it('reports not_found for a field the item does not carry', async () => {
    const { client } = clientFor(new FakeBwServe());
    const missing: SecretField[] = [
      { kind: 'totp' },
      { kind: 'password' },
      { kind: 'card', field: 'number' },
      { kind: 'customField', name: 'nope' },
    ];
    for (const field of missing) {
      expect(unwrapFail(await client.getSecret(FIXTURE_IDS.secureNote, field)).code).toBe(
        'not_found',
      );
    }
  });

  it('reports not_found for an item-backed field of a missing item', async () => {
    const { client } = clientFor(new FakeBwServe());
    const error = unwrapFail(await client.getSecret('missing', { kind: 'card', field: 'number' }));
    expect(error.code).toBe('not_found');
  });

  it('reports the vault as unavailable when locked', async () => {
    const { client } = clientFor(new FakeBwServe({ state: 'locked' }));
    const error = unwrapFail(await client.getSecret(FIXTURE_IDS.login, { kind: 'password' }));
    expect(error.code).toBe('vault_unavailable');
  });
});

describe('BwServeVaultClient.listFolders and listCollections', () => {
  it('VAULT-13 drops the "No Folder" pseudo-folder whether its id is "" (current CLIs) or null', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const listed = await fake.fetch('http://bw.test/list/object/folders');
    const raw = await listed.json();
    expect(raw).toMatchObject({ data: { data: [{}, { id: '', name: 'No Folder' }] } });
    const work = [{ id: FIXTURE_IDS.folder, name: 'Work' }];
    expect(unwrapOk(await client.listFolders())).toStrictEqual(work);
    const older = [{ object: 'folder', id: null, name: 'No Folder' }, ...fake.folders];
    fake.override('GET', '/list/object/folders', {
      success: true,
      data: { object: 'list', data: older },
    });
    expect(unwrapOk(await client.listFolders())).toStrictEqual(work);
  });

  it('lists collections with their organisation', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapOk(await client.listCollections())).toStrictEqual([
      { id: FIXTURE_IDS.collection, name: 'Shared', organizationId: FIXTURE_IDS.organization },
    ]);
  });

  it('propagates failures', async () => {
    const fake = new FakeBwServe({ state: 'locked' });
    const { client } = clientFor(fake);
    expect(unwrapFail(await client.listFolders()).code).toBe('vault_unavailable');
    expect(unwrapFail(await client.listCollections()).code).toBe('vault_unavailable');
  });
});

describe('BwServeVaultClient.generatePassword and generatePassphrase', () => {
  it('asks bw serve to generate with the given options', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const password = unwrapOk(
      await client.generatePassword({
        length: 24,
        uppercase: true,
        lowercase: true,
        numbers: false,
        special: true,
      }),
    );
    expect(password).toBe('x'.repeat(24));
    const passphrase = unwrapOk(
      await client.generatePassphrase({
        words: 4,
        separator: '.',
        capitalize: true,
        includeNumber: false,
      }),
    );
    expect(passphrase).toBe('word.word.word.word');
    expect(fake.requests.map((request) => request.path)).toStrictEqual([
      '/generate?length=24&uppercase=true&lowercase=true&number=false&special=true',
      '/generate?passphrase=true&words=4&separator=.&capitalize=true&includeNumber=false',
    ]);
  });
});
