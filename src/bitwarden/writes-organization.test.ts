import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { FIXTURE_IDS } from '../test-support/fake-vault-fixture.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { BwServeApi } from './api.ts';
import { BwServeVaultClient } from './vault-client.ts';

const SHARED = {
  id: FIXTURE_IDS.collection,
  name: 'Shared',
  organizationId: FIXTURE_IDS.organization,
};
const MOVE_PATH = `/move/${FIXTURE_IDS.secureNote}/${FIXTURE_IDS.organization}`;

function clientFor(fake: FakeBwServe): { client: BwServeVaultClient; clock: ManualClock } {
  const clock = new ManualClock();
  const api = new BwServeApi(() => 'http://127.0.0.1:4242', fake.fetch);
  return { client: new BwServeVaultClient({ api, clock }), clock };
}

describe('createItem in a collection', () => {
  it('MCP-19 sends the organisation and the one collection, and reports them back', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const created = unwrapOk(
      await client.createItem({ type: 'secureNote', name: 'Shared note', collection: SHARED }),
    );
    expect(created).toMatchObject({
      organizationId: FIXTURE_IDS.organization,
      collectionIds: [FIXTURE_IDS.collection],
    });
    const post = fake.requests.find((request) => request.path === '/object/item');
    expect(post?.body).toMatchObject({
      organizationId: FIXTURE_IDS.organization,
      collectionIds: [FIXTURE_IDS.collection],
    });
  });

  it('MCP-19 leaves an item without a collection in the account vault', async () => {
    const fake = new FakeBwServe();
    const { client } = clientFor(fake);
    const created = unwrapOk(await client.createItem({ type: 'secureNote', name: 'Own note' }));
    expect(created).toMatchObject({ organizationId: null, collectionIds: [] });
    const post = fake.requests.find((request) => request.path === '/object/item');
    expect(post?.body).toMatchObject({ organizationId: null, collectionIds: null });
  });
});

describe('moveItem', () => {
  it('MCP-20 posts the collection to /move and waits until the organisation is readable', async () => {
    const fake = new FakeBwServe({ revisionLag: 2 });
    const { client, clock } = clientFor(fake);
    const pending = client.moveItem(FIXTURE_IDS.secureNote, SHARED);
    await clock.advance(200);
    const moved = unwrapOk(await pending);
    expect(moved).toMatchObject({
      id: FIXTURE_IDS.secureNote,
      organizationId: FIXTURE_IDS.organization,
      collectionIds: [FIXTURE_IDS.collection],
    });
    const post = fake.requestsTo(MOVE_PATH);
    expect(post.map((request) => [request.method, request.body])).toStrictEqual([
      ['POST', [FIXTURE_IDS.collection]],
    ]);
    expect(fake.requestsTo('/sync')).toStrictEqual([]);
  });

  it('MCP-20 reports not_found for an unknown item', async () => {
    const { client } = clientFor(new FakeBwServe());
    expect(unwrapFail(await client.moveItem('missing', SHARED)).code).toBe('not_found');
  });

  it('MCP-20 maps a refused move to invalid_item without forwarding its text', async () => {
    const fake = new FakeBwServe();
    fake.override('POST', MOVE_PATH, { success: false, message: 'secret-looking text' });
    const { client } = clientFor(fake);
    const error = unwrapFail(await client.moveItem(FIXTURE_IDS.secureNote, SHARED));
    expect(error.code).toBe('invalid_item');
    expect(error.message).not.toContain('secret-looking text');
  });

  it('VAULT-10 propagates a read failure after the move', async () => {
    const fake = new FakeBwServe();
    fake.override('GET', `/object/item/${FIXTURE_IDS.secureNote}`, 'garbage');
    const { client } = clientFor(fake);
    const error = unwrapFail(await client.moveItem(FIXTURE_IDS.secureNote, SHARED));
    expect(error.code).toBe('vault_protocol_error');
  });
});
