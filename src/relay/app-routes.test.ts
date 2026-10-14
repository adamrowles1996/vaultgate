import { describe, expect, it } from 'vitest';

import {
  relayGet,
  relayHarness,
  RELAY_ID,
  RELAY_SECRET,
  relayText,
  SCOPED_COLLECTION,
} from '../test-support/relay-fixtures.ts';

const UNSCOPED = [RELAY_SECRET.outside, RELAY_SECRET.totpSeed];

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('relay item routes', () => {
  it('RELAY-7 answers an in-scope login as bw serve does, without the TOTP seed', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, `/object/item/${RELAY_ID.database}`);
    expect(response.status).toBe(200);
    expect(await json(response)).toStrictEqual({
      success: true,
      data: {
        object: 'item',
        id: RELAY_ID.database,
        organizationId: '5d0c7a1e-0000-4000-8000-00000000e001',
        folderId: null,
        type: 1,
        reprompt: 0,
        name: 'Reporting database',
        notes: RELAY_SECRET.notes,
        favorite: false,
        fields: [
          { name: 'Host', value: 'db.internal', type: 0, linkedId: null },
          { name: 'Api key', value: RELAY_SECRET.hidden, type: 1, linkedId: null },
          { name: 'Read only', value: 'true', type: 2, linkedId: null },
          { name: 'Linked user', value: null, type: 3, linkedId: null },
        ],
        login: {
          uris: [{ match: null, uri: 'postgres://db.internal:5432/reporting' }],
          username: 'report_reader',
          password: RELAY_SECRET.password,
          totp: null,
          passwordRevisionDate: null,
          fido2Credentials: [],
        },
        collectionIds: [SCOPED_COLLECTION],
        revisionDate: '2026-10-01T09:00:00.000Z',
        deletedDate: null,
        passwordHistory: null,
      },
    });
    expect(harness.audit.events).toStrictEqual([
      {
        category: 'relay',
        action: 'relay.item',
        outcome: 'ok',
        itemId: RELAY_ID.database,
        field: undefined,
        ip: '100.64.0.20',
        details: { node: 'sandbox-1.example.ts.net' },
      },
    ]);
  });

  it('RELAY-7 answers null notes and fields for an item that holds none', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, '/object/item/Mailer');
    const body = (await json(response)) as { data: Record<string, unknown> };
    expect(body.data['notes']).toBeNull();
    expect(body.data['fields']).toStrictEqual([]);
  });

  it('RELAY-4 answers an item listed by id, whatever its collections', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, '/object/item/Deploy%20key');
    const body = (await json(response)) as { data: Record<string, unknown> };
    expect(body.data['secureNote']).toStrictEqual({ type: 0 });
    expect(body.data['notes']).toBe(RELAY_SECRET.noteBody);
    expect(body.data['login']).toBeUndefined();
  });

  it('RELAY-4 answers an out-of-scope, trashed or unsupported item exactly as a missing one', async () => {
    const harness = relayHarness();
    for (const term of [
      RELAY_ID.outside,
      'Payroll database',
      RELAY_ID.trashed,
      RELAY_ID.card,
      'Company card',
      '0f6b2d3c-0000-4000-8000-0000000000ff',
      'nothing-like-this',
    ]) {
      const response = await relayGet(harness, `/object/item/${encodeURIComponent(term)}`);
      expect(response.status).toBe(404);
      expect(await json(response)).toStrictEqual({ success: false, message: 'Not found.' });
    }
    expect(JSON.stringify(harness.audit.events)).not.toContain(RELAY_SECRET.outside);
  });

  it('RELAY-6 resolves a name containing a slash and percent-encoded spaces', async () => {
    const harness = relayHarness();
    const response = await relayGet(
      harness,
      `/object/password/${encodeURIComponent('f/ops/api key')}`,
    );
    expect(await json(response)).toStrictEqual({
      success: true,
      data: { object: 'string', data: 'slashed-password' },
    });
  });

  it('RELAY-6 answers the one exact name among several matches', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, '/object/password/MAILER');
    expect(await json(response)).toStrictEqual({
      success: true,
      data: { object: 'string', data: 'mailer-password' },
    });
  });

  it('RELAY-6 reports several matches as bw serve does when no single name is exact', async () => {
    const harness = relayHarness();
    for (const term of ['Mail', 'twin']) {
      const response = await relayGet(harness, `/object/password/${term}`);
      expect(response.status).toBe(400);
      const { message } = (await json(response)) as { message: string };
      expect(message).toMatch(/^More than one result was found\./);
    }
    const twin = await relayGet(harness, '/object/item/twin');
    const { message } = (await json(twin)) as { message: string };
    expect(message.split('\n').slice(1)).toStrictEqual([RELAY_ID.twin, RELAY_ID.twinCopy]);
    expect(harness.audit.events.at(-1)?.details).toStrictEqual({
      node: 'sandbox-1.example.ts.net',
      reason: 'ambiguous',
      term: 'twin',
    });
  });

  it('RELAY-6 refuses a lookup term longer than 200 characters', async () => {
    const harness = relayHarness();
    const response = await relayGet(harness, `/object/item/${'a'.repeat(201)}`);
    expect(response.status).toBe(400);
    expect(await json(response)).toStrictEqual({
      success: false,
      message: 'The search term is too long.',
    });
  });
});

describe('relay scalar routes', () => {
  it('RELAY-5 answers each scalar of a login as a bw serve string', async () => {
    const harness = relayHarness();
    const expected = {
      password: RELAY_SECRET.password,
      username: 'report_reader',
      notes: RELAY_SECRET.notes,
      totp: '123456',
      uri: 'postgres://db.internal:5432/reporting',
    };
    for (const [kind, value] of Object.entries(expected)) {
      const response = await relayGet(harness, `/object/${kind}/${RELAY_ID.database}`);
      expect(await json(response)).toStrictEqual({
        success: true,
        data: { object: 'string', data: value },
      });
    }
    expect(harness.audit.events.map((event) => event.field)).toStrictEqual(Object.keys(expected));
    expect(harness.audit.events.every((event) => event.action === 'relay.secret')).toBe(true);
  });

  it('RELAY-5 answers an empty string for a value the item does not hold', async () => {
    const harness = relayHarness();
    for (const kind of ['password', 'username', 'totp', 'uri']) {
      const response = await relayGet(harness, `/object/${kind}/${RELAY_ID.note}`);
      expect(await json(response)).toStrictEqual({
        success: true,
        data: { object: 'string', data: '' },
      });
    }
    const noTotp = await relayGet(harness, `/object/totp/${RELAY_ID.mailer}`);
    expect(await json(noTotp)).toStrictEqual({
      success: true,
      data: { object: 'string', data: '' },
    });
  });

  it('RELAY-5 answers no other kind of object', async () => {
    const harness = relayHarness();
    for (const path of [
      `/object/folder/${RELAY_ID.database}`,
      `/object/attachment/${RELAY_ID.database}`,
      '/list/object/folders',
      '/generate',
    ]) {
      const response = await relayGet(harness, path);
      expect(response.status).toBe(404);
      expect(await json(response)).toStrictEqual({ success: false, message: 'Unknown route.' });
    }
    const write = await harness.app.request(`/object/item/${RELAY_ID.database}`, {
      method: 'PUT',
      headers: { host: '100.64.0.10:8087' },
    });
    expect(write.status).toBe(404);
  });

  it('RELAY-4 never answers an unscoped secret on any route', async () => {
    const harness = relayHarness();
    const paths = [
      `/object/password/${RELAY_ID.outside}`,
      `/object/password/${RELAY_ID.trashed}`,
      `/object/item/${RELAY_ID.card}`,
      '/list/object/items?search=database',
      `/object/item/${RELAY_ID.database}`,
    ];
    const bodies = await Promise.all(paths.map(async (path) => relayText(harness, path)));
    for (const secret of UNSCOPED) {
      expect(bodies.join('\n')).not.toContain(secret);
      expect(harness.logged()).not.toContain(secret);
    }
  });
});

describe('relay audit', () => {
  it('RELAY-8 records every routed request with the node, address, item and field, never a value', async () => {
    const harness = relayHarness();
    await relayGet(harness, '/status');
    await harness.app.request('/sync', { method: 'POST', headers: { host: '100.64.0.10:8087' } });
    await relayGet(harness, `/object/item/${RELAY_ID.database}`);
    await relayGet(harness, `/object/password/${RELAY_ID.database}`);
    await relayGet(harness, '/list/object/items?search=Deploy');
    await relayGet(harness, '/object/item/Payroll%20database');
    expect(
      harness.audit.events.map((event) => [event.action, event.outcome, event.itemId, event.field]),
    ).toStrictEqual([
      ['relay.status', 'ok', undefined, undefined],
      ['relay.sync', 'ok', undefined, undefined],
      ['relay.item', 'ok', RELAY_ID.database, undefined],
      ['relay.secret', 'ok', RELAY_ID.database, 'password'],
      ['relay.list', 'ok', RELAY_ID.note, undefined],
      ['relay.item', 'failure', undefined, undefined],
    ]);
    for (const event of harness.audit.events) {
      expect(event).toMatchObject({
        category: 'relay',
        ip: '100.64.0.20',
        details: { node: 'sandbox-1.example.ts.net' },
      });
    }
    const trail = JSON.stringify(harness.audit.events);
    for (const secret of Object.values(RELAY_SECRET)) {
      expect(trail).not.toContain(secret);
    }
  });
});
