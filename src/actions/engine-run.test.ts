import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all } from '../storage/query.ts';
import {
  caller,
  createActionsHarness,
  createHttpTarget,
  errorOf,
  httpInvocation,
  PUBLIC_ADDRESS,
  resultOf,
  storedCalls,
} from '../test-support/actions-fixtures.ts';
import { fixtureTargetRow } from '../test-support/actions-store-fixtures.ts';
import { createEchoConnector } from '../test-support/fake-connector.ts';
import { CANARY } from '../test-support/vault-fixture.ts';
import { VaultError } from '../vault/client.ts';

import { scrubVariants } from './scrub.ts';

import type { TargetChanges } from './targets-repo.ts';
import type { DatabaseSync } from 'node:sqlite';

const USERNAME = 'alice@example.com';
const rowSchema = z.record(z.string(), z.unknown());

function movedTo(baseUrl: string): TargetChanges {
  const row = fixtureTargetRow();
  return {
    description: row.description,
    destination: { base_url: baseUrl },
    internal: row.internal,
    credential: row.credential,
    policy: row.policy,
  };
}

/**
Every row of the two trail tables as text, so a canary anywhere in the store is found.
*/
function storeText(database: DatabaseSync): string {
  return JSON.stringify([
    ...all(database, 'SELECT * FROM action_calls', rowSchema),
    ...all(database, 'SELECT * FROM audit_events', rowSchema),
  ]);
}

describe('running a call', () => {
  it('ACT-55 ACT-56 ACT-58 resolves the destination once per call, hands the pinned address to the connector and keeps nothing between calls', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness);
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(harness.lookups).toStrictEqual([
      'api.example.com',
      'api.example.com',
      'api.example.com',
    ]);
    const [first, second] = harness.connector.contexts;
    expect(first?.pinned).toStrictEqual([
      { host: 'api.example.com', tls: true, address: PUBLIC_ADDRESS },
    ]);
    expect(first).not.toBe(second);
    expect(first?.signal.aborted).toBe(false);
    expect(first?.outputLimit).toStrictEqual({ maxBytes: 262_144, guardBytes: 32 });
  });

  it('ACT-50 exposes the injected values to the connector during run only and zeroes them when the call ends', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness);
    await createHttpTarget(harness, {
      name: 'otp',
      mapping: { mode: 'header', field: 'totp', name: 'X-Code' },
    });
    const result = resultOf(await harness.engine.call(caller(), httpInvocation()));
    const [context] = harness.connector.contexts;
    expect(context?.injected.fields).toStrictEqual(['password']);
    expect(
      context?.injected.value('password')?.equals(Buffer.alloc(CANARY.password.length, 0)),
    ).toBe(true);
    expect(String(result['body'])).toContain('"authorization":"Bearer [redacted:password]"');
    const code = resultOf(await harness.engine.call(caller(), httpInvocation({ target: 'otp' })));
    expect(String(code['body'])).toContain('"x-code":"[redacted:totp]"');
    expect(String(code['body'])).not.toContain('123456');
  });

  it('ACT-51 ACT-53 ACT-61 ACT-64 no canary in any variant reaches the result, the store, the audit sink or the log when the destination echoes the request', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness, { mapping: { mode: 'basic', field: 'password' } });
    await createHttpTarget(harness, {
      name: 'keyed',
      mapping: { mode: 'header', field: 'custom.API key', name: 'X-Api-Key', prefix: 'Token ' },
    });
    const echoing = httpInvocation({ body: `agent echoes ${CANARY.password}` });
    const echoed = resultOf(await harness.engine.call(caller(), echoing));
    const keyedEchoing = httpInvocation({ target: 'keyed', body: `and ${CANARY.hiddenField}` });
    const keyed = resultOf(await harness.engine.call(caller(), keyedEchoing));
    const [basicContext, keyedContext] = harness.connector.contexts;
    expect(basicContext?.injected.username).toBe(USERNAME);
    expect(keyedContext?.injected.fields).toStrictEqual(['custom.API key']);
    expect(String(echoed['body'])).toContain('"authorization":"Basic [redacted:password]"');
    expect(String(echoed['body'])).toContain('"base64":"[redacted:password]"');
    expect(String(keyed['body'])).toContain('"x-api-key":"Token [redacted:custom.API key]"');
    const everything = [
      JSON.stringify([echoed, keyed]),
      storeText(harness.database),
      JSON.stringify(harness.audit),
      JSON.stringify(harness.logged()),
    ].join('\n');
    const variants = [
      ...scrubVariants(CANARY.password, USERNAME),
      ...scrubVariants(CANARY.hiddenField),
    ];
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
    expect(storedCalls(harness.database).map((call) => call.arguments)).toStrictEqual([
      '{"target":"api","method":"GET","path":"/v1/me","body":"agent echoes [redacted:password]"}',
      '{"target":"keyed","method":"GET","path":"/v1/me","body":"and [redacted:custom.API key]"}',
    ]);
  });

  it('ACT-52 captures beyond the cap, scrubs, then cuts at max_output_bytes with truncated set', async () => {
    const harness = createActionsHarness({ connector: createEchoConnector({ repeat: 8 }) });
    await createHttpTarget(harness, { policy: { max_output_bytes: 1024 } });
    const result = resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(result['truncated']).toBe(true);
    expect(Buffer.byteLength(String(result['body']))).toBeLessThanOrEqual(1024);
    expect(String(result['body'])).not.toContain(CANARY.password);
    expect(storedCalls(harness.database)).toMatchObject([
      { outputTruncated: true, outputBytes: 1024 + 32 },
    ]);
    const reported = createActionsHarness({
      connector: createEchoConnector({ result: { truncated: true } }),
    });
    await createHttpTarget(reported);
    const outcome = await reported.engine.call(caller(), httpInvocation());
    expect(resultOf(outcome)).toMatchObject({ truncated: true });
    expect(storedCalls(reported.database)).toMatchObject([{ outputTruncated: true }]);
  });

  it('ACT-54 ACT-4 answers credential_unavailable with one message for a locked vault, a missing item, a missing field and a bad selector, and logs the reason', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness);
    const { repo } = harness.engine.targets;
    repo.insert(
      fixtureTargetRow({
        id: 'no-username',
        name: 'no-username',
        credential: { item_id: 'item-note', mapping: { mode: 'basic', field: 'notes' } },
      }),
    );
    repo.insert(
      fixtureTargetRow({
        id: 'bad-selector',
        name: 'bad-selector',
        credential: { item_id: 'item-login', mapping: { mode: 'bearer', field: 'login.password' } },
      }),
    );
    for (const name of ['no-username', 'bad-selector']) {
      repo.grant(name, 'vg_c_agent', 0, 'operator-1');
    }
    await createHttpTarget(harness, {
      name: 'basic',
      mapping: { mode: 'basic', field: 'password' },
    });
    const failures = [
      new VaultError('vault_unavailable', 'locked'),
      new VaultError('not_found', 'gone'),
      new VaultError('invalid_item', 'no field'),
    ];
    const codes: string[] = [];
    const messages = new Set<string>();
    for (const failure of failures) {
      harness.vault.failWith(failure);
      const error = errorOf(await harness.engine.call(caller(), httpInvocation()));
      codes.push(error.code);
      messages.add(error.message);
    }
    const lockedBasic = await harness.engine.call(caller(), httpInvocation({ target: 'basic' }));
    codes.push(errorOf(lockedBasic).code);
    harness.vault.failWith(null);
    for (const target of ['no-username', 'bad-selector']) {
      const error = errorOf(await harness.engine.call(caller(), httpInvocation({ target })));
      codes.push(error.code);
      messages.add(error.message);
    }
    expect(codes).toStrictEqual(Array.from({ length: 6 }, () => 'credential_unavailable'));
    expect([...messages]).toStrictEqual([
      'the credential for this target is not available; the operator can see why on the account page',
    ]);
    expect(
      harness
        .logged()
        .filter((line) => line['msg'] === 'credential unavailable')
        .map((line) => [line['field'], line['reason']]),
    ).toStrictEqual([
      ['password', 'vault_unavailable'],
      ['password', 'not_found'],
      ['password', 'invalid_item'],
      ['login.username', 'invalid_item'],
      ['login.username', 'missing_field'],
      ['login.password', 'invalid_selector'],
    ]);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual(
      Array.from({ length: 6 }, () => 'error:credential_unavailable'),
    );
  });

  it('ACT-56 ACT-55 refuses a destination that resolves to a refused or no address after the credential was fetched, and zeroes the values', async () => {
    const harness = createActionsHarness({
      addresses: { 'moved.example.com': ['10.0.0.5'], 'gone.example.com': [] },
    });
    await createHttpTarget(harness);
    const { repo } = harness.engine.targets;
    repo.update('id-1', movedTo('https://moved.example.com'), 0, 'operator-1');
    const moved = await harness.engine.call(caller(), httpInvocation());
    expect(errorOf(moved)).toMatchObject({
      code: 'destination_refused',
      detail: { reason: 'private' },
    });
    repo.update('id-1', movedTo('https://gone.example.com'), 0, 'operator-1');
    const gone = await harness.engine.call(caller(), httpInvocation());
    expect(errorOf(gone)).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'unresolved' },
    });
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'error:destination_refused',
      'error:connection_failed',
    ]);
    expect(storeText(harness.database)).not.toContain('moved.example.com');
  });

  it('ACT-59 aborts the connector at the policy timeout and answers timeout', async () => {
    const harness = createActionsHarness({ connector: createEchoConnector({ mode: 'hang' }) });
    await createHttpTarget(harness, { policy: { timeout_ms: 2000 } });
    const pending = harness.engine.call(caller(), httpInvocation());
    await harness.clock.advance(1999);
    expect(harness.connector.contexts[0]?.signal.aborted).toBe(false);
    await harness.clock.advance(1);
    expect(errorOf(await pending).code).toBe('timeout');
    expect(harness.connector.contexts[0]?.signal.aborted).toBe(true);
    expect(harness.clock.pending()).toBe(0);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'error:timeout', durationMs: 2000 },
    ]);
  });

  it('ACT-74 scrubs the detail of a connector error and turns a thrown connector into upstream_error with a capped message', async () => {
    const failing = createActionsHarness({
      connector: createEchoConnector({ mode: 'fail', failWith: 'authentication_failed' }),
    });
    await createHttpTarget(failing);
    const failed = await failing.engine.call(caller(), httpInvocation());
    expect(errorOf(failed)).toMatchObject({
      code: 'authentication_failed',
      message: 'the destination rejected the credential',
      detail: { message: '[redacted:password]' },
    });
    const throwing = createActionsHarness({ connector: createEchoConnector({ mode: 'throw' }) });
    await createHttpTarget(throwing);
    const thrown = await throwing.engine.call(caller(), httpInvocation());
    expect(errorOf(thrown)).toMatchObject({
      code: 'upstream_error',
      detail: { message: 'connector crashed while holding [redacted:password]' },
    });
    const careless = createActionsHarness({
      connector: createEchoConnector({ mode: 'throw_text' }),
    });
    await createHttpTarget(careless);
    const text = await careless.engine.call(caller(), httpInvocation());
    expect(errorOf(text)).toMatchObject({
      code: 'upstream_error',
      detail: { message: 'text [redacted:password]' },
    });
    expect(storedCalls(throwing.database).map((call) => call.outcome)).toStrictEqual([
      'error:upstream_error',
    ]);
  });
});
