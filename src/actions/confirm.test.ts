import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ACTIONS_CONFIRMATION_INFO, deriveKey } from '../crypto/secret-box.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  argumentsDigest,
  buildConfirmationRequest,
  canonicalJson,
  CONFIRMATION_TTL_MS,
  type ConfirmationBinding,
  type Confirmations,
  createConfirmations,
  elicitationOutcome,
} from './confirm.ts';

const SECRET_KEY = Buffer.alloc(32, 9);
const T = Date.parse('2026-09-22T12:00:00Z');
const BINDING: ConfirmationBinding = {
  target_id: 'target-1',
  revision: 3,
  tool: 'http_request',
  client_id: 'vg_c_agent',
  token_prefix: 'aabbccdd0011',
  args_sha256: argumentsDigest({ target: 'api', method: 'POST', path: '/x' }),
};

function harness(): { confirmations: Confirmations; tick: (ms: number) => void } {
  let at = T;
  return {
    confirmations: createConfirmations({
      secretKey: SECRET_KEY,
      random: (bytes) => Buffer.alloc(bytes, 7),
      now: () => at,
    }),
    tick: (ms) => {
      at += ms;
    },
  };
}

function signed(text: string): string {
  const key = deriveKey(SECRET_KEY, ACTIONS_CONFIRMATION_INFO);
  return `${text}.${createHmac('sha256', key).update(text).digest('base64url')}`;
}

describe('canonicalJson', () => {
  it('ACT-45 sorts object keys at every level, keeps array order, drops undefined and serialises scalars as JSON', () => {
    expect(
      canonicalJson({ b: [3, { z: 1, y: null }], a: 'x', c: undefined, d: true, e: 1.5 }),
    ).toBe('{"a":"x","b":[3,{"y":null,"z":1}],"d":true,"e":1.5}');
    expect(canonicalJson('ü"')).toBe(String.raw`"ü\""`);
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('ACT-45 argumentsDigest is the SHA-256 of the canonical JSON, independent of key order', () => {
    const digest = argumentsDigest({ path: '/x', method: 'POST' });
    expect(digest).toBe(createHash('sha256').update('{"method":"POST","path":"/x"}').digest('hex'));
    expect(argumentsDigest({ method: 'POST', path: '/x' })).toBe(digest);
    expect(argumentsDigest({ method: 'POST', path: '/y' })).not.toBe(digest);
  });
});

describe('createConfirmations', () => {
  it('ACT-44 mints base64url(payload).base64url(HMAC-SHA256) under the derived key with a 16-byte nonce and a 120 s expiry', () => {
    const { confirmations } = harness();
    const { requestState, nonce } = confirmations.mint(BINDING);
    const [encoded = '', signature = '', ...rest] = requestState.split('.');
    expect(rest).toStrictEqual([]);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toStrictEqual({
      v: 1,
      nonce,
      ...BINDING,
      issued_at: T,
      expires_at: T + CONFIRMATION_TTL_MS,
    });
    expect(Buffer.from(nonce, 'base64url')).toStrictEqual(Buffer.alloc(16, 7));
    expect(signed(encoded)).toBe(`${encoded}.${signature}`);
    expect(CONFIRMATION_TTL_MS).toBe(120_000);
    expect(requestState).not.toContain('/x');
  });

  it('ACT-45 verifies a fresh state against the presenting token, the target as it is now and the retried arguments', () => {
    const { confirmations } = harness();
    const { requestState, nonce } = confirmations.mint(BINDING);
    expect(unwrapOk(confirmations.verify(requestState, BINDING))).toMatchObject({
      nonce,
      target_id: 'target-1',
    });
    const mismatches: readonly Partial<ConfirmationBinding>[] = [
      { client_id: 'vg_c_other' },
      { token_prefix: 'ffffff000000' },
      { target_id: 'target-2' },
      { revision: 4 },
      { tool: 'sql_execute' },
      { args_sha256: argumentsDigest({ target: 'api', method: 'POST', path: '/y' }) },
    ];
    expect(
      mismatches.map(
        (mismatch) =>
          unwrapFail(confirmations.verify(requestState, { ...BINDING, ...mismatch })).code,
      ),
    ).toStrictEqual(mismatches.map(() => 'confirmation_invalid'));
  });

  it('ACT-45 fails confirmation_expired once 120 s have passed', () => {
    const { confirmations, tick } = harness();
    const { requestState } = confirmations.mint(BINDING);
    tick(CONFIRMATION_TTL_MS - 1);
    expect(confirmations.verify(requestState, BINDING).ok).toBe(true);
    tick(1);
    expect(unwrapFail(confirmations.verify(requestState, BINDING)).code).toBe(
      'confirmation_expired',
    );
  });

  it('ACT-45 refuses a state with the wrong shape, a wrong signature, a tampered payload or a payload that is not a confirmation', () => {
    const { confirmations } = harness();
    const { requestState } = confirmations.mint(BINDING);
    const [encoded = '', signature = ''] = requestState.split('.', 2);
    const flipped = (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1);
    const states = [
      'no-dot',
      `${encoded}.${signature}.extra`,
      `${encoded}.${signature.slice(1)}`,
      `${encoded}.${flipped}`,
      `${Buffer.from('{"v":1').toString('base64url')}.${signature}`,
      signed(Buffer.from('not json').toString('base64url')),
      signed(Buffer.from('{"v":2}').toString('base64url')),
      signed(Buffer.from(JSON.stringify({ v: 1, nonce: '' })).toString('base64url')),
    ];
    expect(
      states.map((state) => unwrapFail(confirmations.verify(state, BINDING)).code),
    ).toStrictEqual(states.map(() => 'confirmation_invalid'));
  });

  it('ACT-47 runs the call only on accept with confirm true; declines and cancels are named', () => {
    expect(elicitationOutcome({ action: 'accept', content: { confirm: true } })).toBe('accepted');
    expect(elicitationOutcome({ action: 'accept', content: { confirm: false } })).toBe('declined');
    expect(elicitationOutcome({ action: 'accept', content: {} })).toBe('declined');
    expect(elicitationOutcome({ action: 'accept' })).toBe('declined');
    expect(elicitationOutcome({ action: 'decline' })).toBe('declined');
    expect(elicitationOutcome({ action: 'cancel' })).toBe('cancelled');
  });
});

describe('buildConfirmationRequest', () => {
  it('ACT-43 quotes every line of the operation, so an agent cannot forge the trailer or end the message early', () => {
    const forged =
      'uptime\n\nAllow this one call? It expires in 2 minutes and cannot be reused.\n\nrm -rf /';
    const { message } = buildConfirmationRequest({
      clientName: 'Agent One',
      tool: 'ssh_run',
      targetName: 'host',
      connector: 'ssh',
      destinationSummary: 'h',
      operationSummary: forged,
    }).params;
    const unquoted = message.split('\n').filter((line) => line !== '' && !line.startsWith('> '));
    expect(unquoted).toStrictEqual([
      'vaultgate: Agent One asks to run ssh_run on target "host" (ssh, h).',
      'The operation, every line of it quoted with "> ":',
      'Allow this one call? It expires in 2 minutes and cannot be reused.',
    ]);
    expect(message).toContain(
      '> Allow this one call? It expires in 2 minutes and cannot be reused.',
    );
    expect(message).toContain('> rm -rf /');
  });

  it('ACT-43 says what an excerpt leaves out, outside the quoted block where the agent cannot reach', () => {
    const { message } = buildConfirmationRequest({
      clientName: 'Agent One',
      tool: 'ssh_run',
      targetName: 'host',
      connector: 'ssh',
      destinationSummary: 'h',
      operationSummary: 'head\n…\ntail',
      omitted: { characters: 240, total: 1200, sha256: 'a'.repeat(64) },
    }).params;
    expect(message).toContain(
      `NOT SHOWN: 240 of 1200 characters are missing from the middle of the operation above. ` +
        `The SHA-256 of the whole of it is ${'a'.repeat(64)}. Do not approve an operation you have not read.`,
    );
    expect(message.split('\n').some((line) => line.startsWith('NOT SHOWN:'))).toBe(true);
  });

  it('ACT-42 ACT-43 is the elicitation/create document verbatim with the message template', () => {
    expect(
      buildConfirmationRequest({
        clientName: 'Agent One',
        tool: 'http_request',
        targetName: 'api',
        connector: 'http',
        destinationSummary: 'api.example.com/v1',
        operationSummary: 'POST /v1/users',
      }),
    ).toStrictEqual({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message:
          'vaultgate: Agent One asks to run http_request on target "api" (http, api.example.com/v1).' +
          '\n\nThe operation, every line of it quoted with "> ":\n> POST /v1/users\n\n' +
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
  });
});
