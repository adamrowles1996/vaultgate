import { describe, expect, it } from 'vitest';

import {
  type ActionsHarness,
  caller,
  confirmationOf,
  createActionsHarness,
  createHttpTarget,
  errorOf,
  httpInvocation,
  OPERATOR_ID,
  type PendingConfirmation,
  resultOf,
  storedCalls,
} from '../test-support/actions-fixtures.ts';
import { CANARY } from '../test-support/vault-fixture.ts';
import { VaultError } from '../vault/client.ts';

import { argumentsDigest, type ElicitResult } from './confirm.ts';

import type { Caller } from './caller.ts';
import type { CallOutcome } from './engine.ts';

const POST = { method: 'POST', path: '/v1/items', body: '{"name":"x"}' };
const ACCEPT: Retry = { result: { action: 'accept', content: { confirm: true } } };

async function confirmedHarness(): Promise<ActionsHarness> {
  const harness = createActionsHarness();
  await createHttpTarget(harness, {
    policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
  });
  return harness;
}

interface Retry {
  readonly result: ElicitResult;
  readonly who?: Partial<Caller>;
  readonly toolArguments?: Readonly<Record<string, unknown>>;
}

function retry(
  harness: ActionsHarness,
  pending: PendingConfirmation,
  answer: Retry,
): Promise<CallOutcome> {
  const who = caller({
    ...answer.who,
    confirmation: { requestState: pending.requestState, result: answer.result },
  });
  return harness.engine.call(who, httpInvocation(answer.toolArguments ?? POST));
}

describe('confirmation through elicitation', () => {
  it('ACT-41 ACT-42 ACT-43 asks for exactly one boolean before touching the vault, records nothing yet, and the message names the destination and the scrubbed operation only', async () => {
    const harness = await confirmedHarness();
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    expect(pending.request).toStrictEqual({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message:
          'vaultgate: Agent One asks to run http_request on target "api" (http, api.example.com/v1).\n\n' +
          'The operation, every line of it quoted with "> ":\n> POST /v1/items\n\n' +
          'Allow this one call? It expires in 2 minutes and cannot be reused.',
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Allow this call',
              description: 'Tick to let vaultgate run the operation shown above, once.',
              default: false,
            },
          },
          required: ['confirm'],
        },
      },
    });
    for (const secret of [CANARY.password, 'item-login', '/**']) {
      expect(pending.request.params.message).not.toContain(secret);
    }
    expect(storedCalls(harness.database)).toStrictEqual([]);
    expect(harness.audit.map((event) => event.category)).toStrictEqual(['actions', 'actions']);
    expect(harness.lookups).toStrictEqual(['api.example.com']);
  });

  it('ACT-40 asks nothing for a read call on a confirmed target', async () => {
    const harness = await confirmedHarness();
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'not_required',
    ]);
  });

  it('ACT-44 mints requestState as base64url(payload).base64url(HMAC) with the bound payload, a 16-byte nonce and a 120 s expiry', async () => {
    const harness = await confirmedHarness();
    const issuedAt = harness.clock.now();
    const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    const [encoded = '', signature = ''] = pending.requestState.split('.', 2);
    expect(signature).toMatch(/^[\w-]{43}$/);
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    expect(payload).toStrictEqual({
      v: 1,
      nonce: Buffer.alloc(16, 1).toString('base64url'),
      target_id: 'id-1',
      revision: 1,
      tool: 'http_request',
      client_id: 'vg_c_agent',
      token_prefix: 'aabbccdd0011',
      args_sha256: argumentsDigest({ target: 'api', ...POST }),
      issued_at: issuedAt,
      expires_at: issuedAt + 120_000,
    });
  });

  it('ACT-45 ACT-46 ACT-47 runs the call on an accepted retry, records the nonce and elicitation, and refuses a replay as confirmation_reused', async () => {
    const harness = await confirmedHarness();
    const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    expect(resultOf(await retry(harness, pending, ACCEPT))['status']).toBe(200);
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        elicitation: 'accepted',
        operation: 'write',
        classification: 'POST',
        confirmationNonce: Buffer.alloc(16, 1).toString('base64url'),
      },
    ]);
    expect(errorOf(await retry(harness, pending, ACCEPT)).code).toBe('confirmation_reused');
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'accepted',
      'invalid',
    ]);
    expect(harness.audit.at(-1)?.details?.['elicitation']).toBe('invalid');
  });

  it('ACT-47 declines on accept without confirm, on decline and cancels on cancel, each audited and none run', async () => {
    const harness = await confirmedHarness();
    const answers: readonly [ElicitResult, string][] = [
      [{ action: 'accept', content: { confirm: false } }, 'confirmation_declined'],
      [{ action: 'accept' }, 'confirmation_declined'],
      [{ action: 'decline' }, 'confirmation_declined'],
      [{ action: 'cancel' }, 'confirmation_cancelled'],
    ];
    for (const [answer, code] of answers) {
      const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
      expect(errorOf(await retry(harness, pending, { result: answer })).code).toBe(code);
    }
    expect(
      storedCalls(harness.database).map((call) => [call.outcome, call.elicitation]),
    ).toStrictEqual([
      ['denied:confirmation_declined', 'declined'],
      ['denied:confirmation_declined', 'declined'],
      ['denied:confirmation_declined', 'declined'],
      ['denied:confirmation_cancelled', 'cancelled'],
    ]);
    expect(harness.connector.contexts).toStrictEqual([]);
  });

  it('ACT-45 refuses an expired state, altered arguments, an edited target, another client and another token', async () => {
    const harness = await confirmedHarness();
    const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    const altered = await retry(harness, pending, {
      ...ACCEPT,
      toolArguments: { ...POST, body: '{"name":"y"}' },
    });
    expect(errorOf(altered).code).toBe('confirmation_invalid');
    const otherClient = await retry(harness, pending, {
      ...ACCEPT,
      who: { clientId: 'vg_c_other' },
    });
    expect(errorOf(otherClient).code).toBe('not_granted');
    const otherToken = await retry(harness, pending, {
      ...ACCEPT,
      who: { tokenPrefix: '000000000000' },
    });
    expect(errorOf(otherToken).code).toBe('confirmation_invalid');
    const target = harness.engine.targets.list()[0];
    harness.engine.targets.setEnabled(target?.id ?? '', true, OPERATOR_ID);
    expect(errorOf(await retry(harness, pending, ACCEPT)).code).toBe('confirmation_invalid');
    const fresh = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    await harness.clock.advance(120_000);
    expect(errorOf(await retry(harness, fresh, ACCEPT)).code).toBe('confirmation_expired');
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'denied:confirmation_invalid',
      'denied:not_granted',
      'denied:confirmation_invalid',
      'denied:confirmation_invalid',
      'denied:confirmation_expired',
    ]);
  });

  it('ACT-48 refuses a client without form elicitation before anything else happens, with the fixed message', async () => {
    const harness = await confirmedHarness();
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    harness.lookups.length = 0;
    const outcome = await harness.engine.call(
      caller({ elicitation: 'none' }),
      httpInvocation(POST),
    );
    expect(errorOf(outcome)).toMatchObject({
      code: 'confirmation_unavailable',
      message:
        'this target requires a human confirmation and your client does not support MCP ' +
        'elicitation; ask the operator to use a client that does, or to lift the requirement for ' +
        'this target',
    });
    expect(harness.lookups).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:confirmation_unavailable', elicitation: 'unavailable' },
    ]);
  });

  it('ACT-46 the call-recording transaction is the backstop when two retries race past the first nonce check', async () => {
    const harness = await confirmedHarness();
    const pending = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    const [first, second] = await Promise.all([
      retry(harness, pending, ACCEPT),
      retry(harness, pending, ACCEPT),
    ]);
    expect([first.kind, errorOf(second).code]).toStrictEqual(['ok', 'confirmation_reused']);
    expect(
      storedCalls(harness.database).map((call) => [call.outcome, call.confirmationNonce]),
    ).toStrictEqual([
      ['ok', Buffer.alloc(16, 1).toString('base64url')],
      ['denied:confirmation_reused', undefined],
    ]);
    const locked = confirmationOf(await harness.engine.call(caller(), httpInvocation(POST)));
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const failures = await Promise.all([
      retry(harness, locked, ACCEPT),
      retry(harness, locked, ACCEPT),
    ]);
    expect(failures.map((outcome) => errorOf(outcome).code)).toStrictEqual([
      'credential_unavailable',
      'confirmation_reused',
    ]);
  });
});
