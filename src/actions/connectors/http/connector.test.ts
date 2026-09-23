import { describe, expect, it } from 'vitest';

import {
  caller,
  createHttpTarget,
  errorOf,
  httpInvocation,
  resultOf,
  storedCalls,
} from '../../../test-support/actions-fixtures.ts';
import {
  echoResponse,
  harnessOver,
  surfaces,
  textResponse as text,
} from '../../../test-support/http-connector.ts';
import { InMemoryVaultClient } from '../../../test-support/in-memory-vault-client.ts';
import { CANARY, FIXTURE_ITEMS, type StoredItem } from '../../../test-support/vault-fixture.ts';
import { scrubVariants } from '../../scrub.ts';

const USERNAME = 'alice@example.com';

/**
A login whose password has characters the URL and form encodings change.
*/
const SPACED_ITEM: StoredItem = {
  summary: {
    id: 'item-spaced',
    name: 'Spaced',
    type: 'login',
    folderId: null,
    organizationId: null,
    collectionIds: [],
    favorite: false,
    revisionDate: '2026-09-01T09:00:00.000Z',
    deletedDate: null,
    login: { username: 'bob', uris: [], hasPassword: true, hasTotp: false },
    hasNotes: false,
    customFields: [],
  },
  secrets: { password: 'CANARY PASS&WORD/9f' },
};

describe('the http connector through the engine: secret handling', () => {
  it('ACT-75 ACT-53 ACT-51 ACT-79 no variant of the credential reaches the result, the action_calls row, the audit trail or the log in bearer, basic, header and query mode when the destination echoes everything', async () => {
    const { fake, harness } = harnessOver((request) => echoResponse(request));
    await createHttpTarget(harness);
    await createHttpTarget(harness, {
      name: 'basic',
      mapping: { mode: 'basic', field: 'password' },
    });
    await createHttpTarget(harness, {
      name: 'keyed',
      mapping: { mode: 'header', field: 'custom.API key', name: 'X-Api-Key', prefix: 'Token ' },
    });
    await createHttpTarget(harness, {
      name: 'queried',
      mapping: { mode: 'query', field: 'password', name: 'key' },
      policy: { allow_query_credentials: true },
    });
    const invocations = [
      httpInvocation({ path: '/me?q=x', body: `echo ${CANARY.password}` }),
      httpInvocation({ target: 'basic', path: '/me?q=x' }),
      httpInvocation({ target: 'keyed', path: '/me?q=x', body: `echo ${CANARY.hiddenField}` }),
      httpInvocation({ target: 'queried', path: '/me?q=x' }),
    ];
    const who = caller();
    const results: Record<string, unknown>[] = [];
    for (const invocation of invocations) {
      const outcome = await harness.engine.call(who, invocation);
      results.push({ ...resultOf(outcome) });
    }
    expect(fake.requests.map((request) => request.headers['authorization'])).toStrictEqual([
      `Bearer ${CANARY.password}`,
      `Basic ${Buffer.from(`${USERNAME}:${CANARY.password}`).toString('base64')}`,
      undefined,
      undefined,
    ]);
    expect(fake.requests[2]?.headers['x-api-key']).toBe(`Token ${CANARY.hiddenField}`);
    expect(fake.requests[3]?.url).toBe(
      `https://api.example.com/v1/me?q=x&key=${encodeURIComponent(CANARY.password)}`,
    );
    const bodies = results.map((result) => String(result['body']));
    expect(bodies[0]).toContain('"authorization":"Bearer [redacted:password]"');
    expect(bodies[1]).toContain('"authorization":"Basic [redacted:password]"');
    expect(bodies[2]).toContain('"x-api-key":"Token [redacted:custom.API key]"');
    expect(bodies[3]).toContain('key=[redacted:password]');
    expect(bodies[0]).toContain('"body":"echo [redacted:password]"');
    expect(bodies[2]).toContain('"body":"echo [redacted:custom.API key]"');
    const everything = surfaces(harness, results);
    const variants = [
      ...scrubVariants(CANARY.password, USERNAME),
      ...scrubVariants(CANARY.hiddenField),
    ];
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
  });

  it('ACT-51 ACT-79 a query credential with reserved characters is sent URL-encoded and scrubbed in its raw, URL-encoded and form-encoded forms', async () => {
    const { fake, harness } = harnessOver((request) => echoResponse(request), {
      vault: new InMemoryVaultClient([...FIXTURE_ITEMS, SPACED_ITEM]),
    });
    await createHttpTarget(harness, {
      item_id: 'item-spaced',
      mapping: { mode: 'query', field: 'password', name: 'key' },
      policy: { allow_query_credentials: true },
    });
    const outcome = await harness.engine.call(caller(), httpInvocation({ path: '/me' }));
    const result = resultOf(outcome);
    expect(fake.requests[0]?.url).toBe(
      'https://api.example.com/v1/me?key=CANARY%20PASS%26WORD%2F9f',
    );
    const body = String(result['body']);
    expect(body).toContain('key=[redacted:password]');
    for (const form of [
      'CANARY PASS&WORD/9f',
      'CANARY%20PASS%26WORD%2F9f',
      'CANARY+PASS%26WORD%2F9f',
    ]) {
      expect(surfaces(harness, [result])).not.toContain(form);
    }
  });

  it('ACT-52 the guard band catches a credential straddling the cut at the wire', async () => {
    const straddling = `${'a'.repeat(1020)}${CANARY.password}${'b'.repeat(200)}`;
    const { harness } = harnessOver(() => text(200, straddling));
    await createHttpTarget(harness, { policy: { max_output_bytes: 1024 } });
    const result = resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(result['truncated']).toBe(true);
    expect(String(result['body'])).not.toContain('CANARY');
    expect(String(result['body']).startsWith('a'.repeat(1020))).toBe(true);
    expect(Buffer.byteLength(String(result['body']))).toBeLessThanOrEqual(1024);
    expect(storedCalls(harness.database)).toMatchObject([{ outputTruncated: true }]);
  });

  it('ACT-59 the policy timeout aborts the transport request and answers timeout', async () => {
    const { fake, harness } = harnessOver(() => 'hang');
    await createHttpTarget(harness, { policy: { timeout_ms: 2000 } });
    const pending = harness.engine.call(caller(), httpInvocation());
    await harness.clock.advance(1999);
    expect(fake.requests[0]?.signal.aborted).toBe(false);
    await harness.clock.advance(1);
    expect(errorOf(await pending).code).toBe('timeout');
    expect(fake.requests[0]?.signal.aborted).toBe(true);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'error:timeout' }]);
  });

  it('ACT-21 ACT-60 a 401 from the destination is a normal result, recorded as ok with the method as classification', async () => {
    const { harness } = harnessOver(() => text(401, 'who are you'));
    await createHttpTarget(harness);
    const result = resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(result).toMatchObject({ status: 401, body: 'who are you', bytes: 11, truncated: false });
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', operation: 'read', classification: 'GET', outputBytes: 11 },
    ]);
  });
});
