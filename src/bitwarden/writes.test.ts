import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { FIXTURE_IDS } from '../test-support/fake-vault-fixture.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { BwServeApi } from './api.ts';
import { BwServeVaultClient } from './vault-client.ts';

function clientFor(fake: FakeBwServe): { client: BwServeVaultClient; clock: ManualClock } {
  const clock = new ManualClock();
  const api = new BwServeApi(() => 'http://127.0.0.1:4242', fake.fetch);
  return { client: new BwServeVaultClient({ api, clock }), clock };
}

function itemReads(fake: FakeBwServe, id: string): number {
  return fake.requestsTo(`/object/item/${id}`).filter((request) => request.method === 'GET').length;
}

describe('createItem', () => {
  it('creates a login and returns the summary once it is readable', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const created = unwrapOk(
      await client.createItem({
        type: 'login',
        name: 'New login',
        login: { username: 'u', password: 'p', uris: ['https://new.example'] },
      }),
    );
    expect(created).toMatchObject({
      id: 'created-1',
      name: 'New login',
      type: 'login',
      login: { username: 'u', uris: ['https://new.example'], hasPassword: true, hasTotp: false },
    });
    expect(JSON.stringify(created)).not.toContain('"p"');
    expect(itemReads(fake, 'created-1')).toBe(1);
  });

  it('VAULT-10 polls until the new revision is visible and triggers no sync', async () => {
    const fake = new FakeBwServe({ revisionLag: 3 });
    const { client, clock } = clientFor(fake);
    const pending = client.createItem({ type: 'secureNote', name: 'Note' });
    await clock.advance(300);
    const created = unwrapOk(await pending);
    expect(created.id).toBe('created-1');
    expect(itemReads(fake, 'created-1')).toBe(4);
    expect(fake.requestsTo('/sync')).toStrictEqual([]);
  });

  it('VAULT-10 gives up after five seconds and returns what was last observed', async () => {
    const fake = new FakeBwServe({ revisionLag: 1000 });
    const { client, clock } = clientFor(fake);
    const pending = client.updateItem(FIXTURE_IDS.login, { name: 'Renamed' });
    await clock.advance(5000);
    const observed = unwrapOk(await pending);
    expect(observed.name).toBe('Example login');
    expect(itemReads(fake, FIXTURE_IDS.login)).toBe(52);
  });

  it('maps a rejected create to invalid_item', async () => {
    const { client } = clientFor(new FakeBwServe());
    const error = unwrapFail(await client.createItem({ type: 'login', name: '' }));
    expect(error.code).toBe('invalid_item');
    expect(error.message).toBe('the vault rejected the request');
  });

  it('propagates a read failure after the write', async () => {
    const fake = new FakeBwServe();
    fake.override('GET', '/object/item/created-1', 'garbage');
    const { client } = clientFor(fake);
    const error = unwrapFail(await client.createItem({ type: 'login', name: 'x' }));
    expect(error.code).toBe('vault_protocol_error');
  });
});

describe('updateItem', () => {
  it('reads, patches and writes the item back, then waits for the revision', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const updated = unwrapOk(
      await client.updateItem(FIXTURE_IDS.login, {
        name: 'Renamed',
        favorite: false,
        login: { username: 'carol' },
      }),
    );
    expect(updated).toMatchObject({
      id: FIXTURE_IDS.login,
      name: 'Renamed',
      favorite: false,
      login: { username: 'carol', hasPassword: true, hasTotp: true },
    });
    expect(updated.revisionDate).not.toBe('2026-09-01T09:00:00.000Z');
    const put = fake.requests.find((request) => request.method === 'PUT');
    expect(put?.body).toMatchObject({ name: 'Renamed', login: { username: 'carol' } });
  });

  it('reports not_found for an unknown item', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapFail(await client.updateItem('missing', { name: 'x' })).code).toBe('not_found');
  });

  it('maps a rejected update to invalid_item', async () => {
    const { client } = clientFor(new FakeBwServe());
    const error = unwrapFail(await client.updateItem(FIXTURE_IDS.login, { name: '' }));
    expect(error.code).toBe('invalid_item');
  });
});

describe('trashItem', () => {
  it('soft-deletes and waits until the deletion is readable', async () => {
    const fake = new FakeBwServe({ revisionLag: 2 });
    const { client, clock } = clientFor(fake);
    const pending = client.trashItem(FIXTURE_IDS.card);
    await clock.advance(200);
    expect(await pending).toStrictEqual({ ok: true, value: undefined });
    expect(unwrapOk(await client.getItem(FIXTURE_IDS.card)).deletedDate).not.toBeNull();
    expect(fake.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });

  it('reports not_found for an unknown item', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapFail(await client.trashItem('missing')).code).toBe('not_found');
  });

  it('propagates a read failure after the delete', async () => {
    const fake = new FakeBwServe();
    fake.override('GET', `/object/item/${FIXTURE_IDS.card}`, '{"success":false}');
    const { client } = clientFor(fake);
    expect(unwrapFail(await client.trashItem(FIXTURE_IDS.card)).code).toBe('vault_protocol_error');
  });
});

describe('createFolder', () => {
  it('creates a folder', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapOk(await client.createFolder('Personal'))).toStrictEqual({
      id: 'folder-1',
      name: 'Personal',
    });
  });

  it('maps a rejected folder to invalid_item', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapFail(await client.createFolder('')).code).toBe('invalid_item');
  });
});
