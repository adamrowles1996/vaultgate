import { describe, expect, it } from 'vitest';

import { toOutput, transportFailure } from './response.ts';
import { httpPolicySchema } from './schemas.ts';

const POLICY = httpPolicySchema.parse({ allowed_paths: ['/**'] });
const LIMIT = 1024;

function answer(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('toOutput', () => {
  it("ACT-21 returns the status, only the policy's response headers, the body as text, its size and truncated when over the limit", () => {
    const headers = {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '5',
      'x-secret-header': 'no',
      'retry-after': '3',
    };
    const output = toOutput(answer(404, headers), Buffer.from('hello'), POLICY, LIMIT);
    expect(output.result).toStrictEqual({
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': '5',
        'retry-after': '3',
      },
      bytes: 5,
      truncated: false,
    });
    expect(output.captured['body']?.toString('utf8')).toBe('hello');
    const chosen = httpPolicySchema.parse({
      allowed_paths: ['/**'],
      response_headers: ['X-Secret-Header'],
    });
    expect(toOutput(answer(200, headers), Buffer.alloc(0), chosen, LIMIT).result).toStrictEqual({
      status: 200,
      headers: { 'x-secret-header': 'no' },
      bytes: 0,
      truncated: false,
    });
    const over = toOutput(answer(200, headers), Buffer.alloc(LIMIT + 6, 'a'), POLICY, LIMIT);
    expect(over.result).toMatchObject({ bytes: LIMIT + 6, truncated: true });
    expect(over.captured['body']?.length).toBe(LIMIT + 6);
  });

  it('ACT-21 the text rule: a textual media type (text/*, JSON, XML, JavaScript, form-encoded, +json, +xml, or none) in valid UTF-8 is text; anything else is base64 with body_encoding', () => {
    const utf8 = Buffer.from('café {"a":1}', 'utf8');
    const textual = [
      'text/html',
      'TEXT/PLAIN; charset=utf-8',
      'application/json',
      'application/problem+json',
      'application/atom+xml',
      'application/xml',
      'application/javascript',
      'application/x-www-form-urlencoded',
    ];
    for (const type of textual) {
      const output = toOutput(answer(200, { 'content-type': type }), utf8, POLICY, LIMIT);
      expect(output.result).not.toHaveProperty('body_encoding');
      expect(output.captured['body']).toBe(utf8);
    }
    expect(toOutput(answer(200, {}), utf8, POLICY, LIMIT).result).not.toHaveProperty(
      'body_encoding',
    );
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const binary = [
      [{ 'content-type': 'application/octet-stream' }, Buffer.from('plain ascii')],
      [{ 'content-type': 'image/png' }, utf8],
      [{ 'content-type': 'text/plain' }, latin1],
      [{}, latin1],
    ] as const;
    for (const [headers, bytes] of binary) {
      const output = toOutput(answer(200, headers), bytes, POLICY, LIMIT);
      expect(output.result).toMatchObject({ body_encoding: 'base64', bytes: bytes.length });
      expect(output.captured['body']?.toString('ascii')).toBe(bytes.toString('base64'));
    }
  });

  it('ACT-21 ACT-52 cuts a binary body to the largest base64 that fits the limit and marks it truncated', () => {
    const raw = Buffer.alloc(1000, 0xff);
    const output = toOutput(answer(200, { 'content-type': 'image/png' }), raw, POLICY, 100);
    expect(output.result).toMatchObject({ body_encoding: 'base64', bytes: 1000, truncated: true });
    const body = output.captured['body']?.toString('ascii') ?? '';
    expect(body).toHaveLength(100);
    expect(Buffer.from(body, 'base64')).toStrictEqual(raw.subarray(0, 75));
    const small = toOutput(
      answer(200, { 'content-type': 'image/png' }),
      raw.subarray(0, 30),
      POLICY,
      100,
    );
    expect(small.result).toMatchObject({ truncated: false, bytes: 30 });
    expect(small.captured['body']?.length).toBe(40);
  });
});

describe('transportFailure', () => {
  it('ACT-59 an abort, by error name or by the signal, is timeout with no detail', () => {
    const idle = new AbortController().signal;
    expect(transportFailure(new DOMException('gone', 'AbortError'), idle)).toMatchObject({
      code: 'timeout',
      detail: undefined,
    });
    expect(transportFailure(new Error('socket closed'), AbortSignal.abort())).toMatchObject({
      code: 'timeout',
    });
  });

  it('ACT-57 certificate and TLS failures are tls_error, named by code only', () => {
    const codes = [
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'HOSTNAME_MISMATCH',
      'EPROTO',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ERR_OSSL_EVP_UNSUPPORTED',
    ];
    const idle = new AbortController().signal;
    const failures = codes.map((code) =>
      transportFailure(coded('bad cert for 93.184.216.34', code), idle),
    );
    expect(failures.map((failure) => [failure.code, failure.detail])).toStrictEqual(
      codes.map((code) => ['tls_error', { reason: code }]),
    );
  });

  it('ACT-74 ACT-16 everything else is connection_failed with the code, never the message or the address', () => {
    const idle = new AbortController().signal;
    const refused = transportFailure(
      coded('connect ECONNREFUSED 93.184.216.34:443', 'ECONNREFUSED'),
      idle,
    );
    expect(refused).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'ECONNREFUSED' },
    });
    expect(JSON.stringify(refused.detail)).not.toContain('93.184');
    expect(transportFailure(new TypeError('odd'), idle).detail).toStrictEqual({
      reason: 'TypeError',
    });
    expect(transportFailure(new Error('no code'), idle).detail).toStrictEqual({ reason: 'Error' });
    const numeric = Object.assign(new Error('n'), { code: 7 });
    expect(transportFailure(numeric, idle).detail).toStrictEqual({ reason: 'Error' });
    expect(transportFailure('text', idle).detail).toStrictEqual({ reason: 'unknown' });
  });
});
