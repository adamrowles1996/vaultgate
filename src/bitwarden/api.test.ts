import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';
import { VaultError } from '../vault/client.ts';

import {
  BwServeApi,
  CALL_TIMEOUT_MS,
  type FetchFunction,
  TIMED_OUT_MESSAGE,
  vaultError,
} from './api.ts';

const ENDPOINT = 'http://127.0.0.1:4242';
const schema = z.object({ value: z.number() });

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function respondingWith(body: string | Error): { api: BwServeApi; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFunction: FetchFunction = (url, init) => {
    calls.push({ url, init });
    return typeof body === 'string' ? Promise.resolve(new Response(body)) : Promise.reject(body);
  };
  return { api: new BwServeApi(() => ENDPOINT, fetchFunction), calls };
}

describe('BwServeApi', () => {
  it('sends the request and validates the envelope data with the schema', async () => {
    const { api, calls } = respondingWith('{"success":true,"data":{"value":7}}');
    const result = await api.call({ method: 'GET', path: '/thing?x=1', schema });
    expect(unwrapOk(result)).toStrictEqual({ value: 7 });
    expect(calls).toStrictEqual([
      {
        url: `${ENDPOINT}/thing?x=1`,
        init: {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: expect.any(AbortSignal) as AbortSignal,
        },
      },
    ]);
  });

  it('serialises a body as JSON', async () => {
    const { api, calls } = respondingWith('{"success":true,"data":{"value":1}}');
    await api.call({ method: 'POST', path: '/unlock', body: { password: 'pw' }, schema });
    expect(calls[0]?.init).toStrictEqual({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"password":"pw"}',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('VAULT-5 reports vault_unavailable while no bw serve endpoint exists', async () => {
    const endpoints: (string | undefined)[] = [];
    const api = new BwServeApi(
      () => endpoints[0],
      () => Promise.reject(new Error('must not be called')),
    );
    const error = unwrapFail(await api.call({ method: 'GET', path: '/status', schema }));
    expect(error).toBeInstanceOf(VaultError);
    expect(error.code).toBe('vault_unavailable');
  });

  it('VAULT-16 aborts a call that bw serve never answers and reports vault_unavailable', async () => {
    const clock = new ManualClock();
    const signals: AbortSignal[] = [];
    const api = new BwServeApi(
      () => ENDPOINT,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            return;
          }
          signals.push(signal);
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      clock,
    );
    const pending = api.call({ method: 'POST', path: '/sync', schema });
    await clock.advance(CALL_TIMEOUT_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    await clock.advance(1);
    expect(signals[0]?.aborted).toBe(true);
    const error = unwrapFail(await pending);
    expect(error.code).toBe('vault_unavailable');
    expect(error.message).toBe(TIMED_OUT_MESSAGE);
    expect(clock.pending()).toBe(0);
  });

  it('VAULT-16 releases the deadline timer once the call answers', async () => {
    const clock = new ManualClock();
    const api = new BwServeApi(
      () => ENDPOINT,
      () => Promise.resolve(new Response('{"success":true,"data":{"value":1}}')),
      clock,
    );
    expect(unwrapOk(await api.call({ method: 'GET', path: '/status', schema }))).toStrictEqual({
      value: 1,
    });
    expect(clock.pending()).toBe(0);
  });

  it('VAULT-5 reports vault_unavailable when the loopback connection fails', async () => {
    const { api } = respondingWith(new Error('ECONNREFUSED 127.0.0.1:4242 /var/lib/vaultgate'));
    const error = unwrapFail(await api.call({ method: 'GET', path: '/status', schema }));
    expect(error.code).toBe('vault_unavailable');
    expect(error.message).toBe('the vault is locked or not reachable');
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('/var/lib');
  });

  it('VAULT-12 fails closed on a body that is not JSON', async () => {
    const { api } = respondingWith('<html>nope</html>');
    const error = unwrapFail(await api.call({ method: 'GET', path: '/status', schema }));
    expect(error.code).toBe('vault_protocol_error');
  });

  it('VAULT-12 fails closed on JSON that is not a bw serve envelope', async () => {
    const { api } = respondingWith('{"ok":true}');
    const error = unwrapFail(await api.call({ method: 'GET', path: '/status', schema }));
    expect(error.code).toBe('vault_protocol_error');
  });

  it('VAULT-12 fails closed when the data does not match the schema', async () => {
    const { api } = respondingWith('{"success":true,"data":{"value":"seven"}}');
    const error = unwrapFail(await api.call({ method: 'GET', path: '/status', schema }));
    expect(error.code).toBe('vault_protocol_error');
    expect(error.message).toBe('the vault gave an unexpected response');
  });

  it('maps a "not found" rejection to not_found', async () => {
    const { api } = respondingWith('{"success":false,"message":"Not found."}');
    const error = unwrapFail(await api.call({ method: 'GET', path: '/object/item/x', schema }));
    expect(error.code).toBe('not_found');
  });

  it('maps a locked or logged-out rejection to vault_unavailable', async () => {
    for (const message of ['Vault is locked.', 'You are not logged in.']) {
      const { api } = respondingWith(JSON.stringify({ success: false, message }));
      const error = unwrapFail(await api.call({ method: 'GET', path: '/sync', schema }));
      expect(error.code).toBe('vault_unavailable');
    }
  });

  it('VAULT-14 reports a rejected master password without repeating it', async () => {
    const { api } = respondingWith('{"success":false,"message":"Invalid master password."}');
    const error = unwrapFail(await api.call({ method: 'POST', path: '/unlock', schema }));
    expect(error.code).toBe('vault_unavailable');
    expect(error.message).toBe('the vault rejected the master password');
  });

  it("maps any other rejection to the request's rejected code", async () => {
    const { api } = respondingWith('{"success":false,"message":"Name is required."}');
    const error = unwrapFail(
      await api.call({
        method: 'POST',
        path: '/object/item',
        schema,
        rejectedCode: 'invalid_item',
      }),
    );
    expect(error.code).toBe('invalid_item');
  });

  it('VAULT-14 never repeats a rejection message and treats a missing one as a protocol error', async () => {
    const { api } = respondingWith('{"success":false}');
    const error = unwrapFail(await api.call({ method: 'GET', path: '/x', schema }));
    expect(error.code).toBe('vault_protocol_error');
  });

  it('VAULT-14 keeps the secret named in a rejection out of the error', async () => {
    const { api } = respondingWith(
      '{"success":false,"message":"Cannot write item CANARY-NAME at /data/bw/data.json"}',
    );
    const error = unwrapFail(await api.call({ method: 'PUT', path: '/object/item/x', schema }));
    expect(error.message).not.toContain('CANARY');
    expect(error.message).not.toContain('/data');
  });
});

describe('vaultError', () => {
  it('builds a VaultError with a fixed message per code', () => {
    const error = vaultError('not_found');
    expect(error.name).toBe('VaultError');
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('no such item, folder or field');
  });
});
