import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { CANARY, FIXTURE_IDS, fixtureItems } from '../test-support/fake-vault-fixture.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { BwServeApi } from './api.ts';
import { withFieldEdits } from './items.ts';
import { itemSchema, type RawItem } from './types.ts';
import { BwServeVaultClient } from './vault-client.ts';

function login(): RawItem {
  return itemSchema.parse(fixtureItems().find((item) => item['id'] === FIXTURE_IDS.login));
}

function clientFor(fake: FakeBwServe): BwServeVaultClient {
  const api = new BwServeApi(() => 'http://127.0.0.1:4242', fake.fetch);
  return new BwServeVaultClient({ api, clock: new ManualClock() });
}

describe('withFieldEdits', () => {
  it('MCP-17 keeps what bw serve gave a renamed field and builds a new one', () => {
    const original = login();
    const [environment, apiKey, mfa, linked] = original.fields ?? [];
    const edited = unwrapOk(
      withFieldEdits(original, {
        rename: [
          { from: 'api-key', to: 'Sandbox - api-key' },
          { from: 'linked', to: 'linked 2' },
        ],
        remove: ['environment'],
        set: [
          { name: 'mfa', value: 'false' },
          { name: 'Production - api-key', value: '' },
        ],
      }),
    );
    expect(environment).toBeDefined();
    expect(edited.fields).toStrictEqual([
      { ...apiKey, name: 'Sandbox - api-key' },
      { ...mfa, name: 'mfa', value: 'false', type: 2 },
      { ...linked, name: 'linked 2' },
      { name: 'Production - api-key', value: null, type: 1 },
    ]);
    expect(edited.fields?.[0]?.value).toBe(CANARY.hiddenField);
  });

  it('MCP-17 edits an item with no fields, or one whose field the vault left unnamed', () => {
    const bare: RawItem = { id: 'x', name: 'bare', type: 2, revisionDate: '2026-01-01T00:00:00Z' };
    expect(
      unwrapOk(withFieldEdits(bare, { set: [{ name: 'f', value: 'v' }] })).fields,
    ).toStrictEqual([{ name: 'f', value: 'v', type: 1 }]);
    const unnamed: RawItem = { ...bare, fields: [{ name: null, value: 'keep', type: 0 }] };
    expect(unwrapOk(withFieldEdits(unnamed, {})).fields).toStrictEqual(unnamed.fields);
  });

  it('MCP-17 passes on why an edit cannot apply', () => {
    const error = unwrapFail(withFieldEdits(login(), { remove: ['missing'] }));
    expect(error.code).toBe('invalid_item');
  });
});

describe('updateItem with field edits', () => {
  it('MCP-17 writes the edited fields back with the rest of the patch', async () => {
    const fake = new FakeBwServe();
    const updated = unwrapOk(
      await clientFor(fake).updateItem(FIXTURE_IDS.login, {
        name: 'Renamed',
        fieldEdits: { rename: [{ from: 'api-key', to: 'Sandbox - api-key' }] },
      }),
    );
    expect(updated.customFields.map((field) => field.name)).toStrictEqual([
      'environment',
      'Sandbox - api-key',
      'mfa',
      'linked',
    ]);
    const put = fake.requests.find((request) => request.method === 'PUT');
    expect(put?.body).toMatchObject({ name: 'Renamed' });
    expect(JSON.stringify(updated)).not.toContain(CANARY.hiddenField);
  });

  it('MCP-17 sends nothing when the edit cannot apply', async () => {
    const fake = new FakeBwServe();
    const error = unwrapFail(
      await clientFor(fake).updateItem(FIXTURE_IDS.login, { fieldEdits: { remove: ['missing'] } }),
    );
    expect(error).toMatchObject({
      code: 'invalid_item',
      message: "the item has no custom field named 'missing'",
    });
    expect(fake.requests.some((request) => request.method === 'PUT')).toBe(false);
  });
});
