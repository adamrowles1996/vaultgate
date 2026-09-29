import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';

import { DEFAULT_LIFETIME_S, tokenOutcome } from './token-response.ts';

import type { TokenGrant } from './token-response.ts';
import type { ActionError } from '../../errors.ts';

const TOKEN = 'an-access-token';

function outcome(body: unknown, status = 200): ReturnType<typeof tokenOutcome> {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return tokenOutcome(new Response(null, { status }), raw);
}

function grantOf(body: unknown): TokenGrant {
  return unwrapOk(outcome(body));
}

function failureOf(body: unknown, status = 200): ActionError {
  return unwrapFail(outcome(body, status));
}

const INVALID = { code: 'upstream_error', detail: { reason: 'invalid_token_response' } };

describe('a token endpoint answer', () => {
  it('ACT-126 reads expires_in as an integer or a string of digits, and takes 300 s when there is none', () => {
    expect(grantOf({ access_token: TOKEN, expires_in: 3600 })).toStrictEqual({
      accessToken: TOKEN,
      expiresInMs: 3_600_000,
      refreshToken: undefined,
    });
    expect(grantOf({ access_token: TOKEN, expires_in: '1800' }).expiresInMs).toBe(1_800_000);
    expect(DEFAULT_LIFETIME_S).toBe(300);
    expect(grantOf({ access_token: TOKEN }).expiresInMs).toBe(300_000);
    expect(grantOf({ access_token: TOKEN, expires_in: null }).expiresInMs).toBe(300_000);
  });

  it('ACT-126 returns the refresh token when there is one and ignores token_type, which the prefix decides', () => {
    expect(
      grantOf({ access_token: TOKEN, token_type: 'mac', refresh_token: 'next-refresh' }),
    ).toStrictEqual({ accessToken: TOKEN, expiresInMs: 300_000, refreshToken: 'next-refresh' });
    expect(grantOf({ access_token: TOKEN, refresh_token: null }).refreshToken).toBeUndefined();
  });

  it('T33 ACT-126 refuses a 2xx that is neither a grant nor an OAuth error rather than reading a field off it', () => {
    const shapes: readonly unknown[] = [
      { access_token: TOKEN, expires_in: 'soon' },
      { access_token: TOKEN, expires_in: '0' },
      { access_token: TOKEN, expires_in: 0 },
      { access_token: TOKEN, expires_in: -5 },
      { access_token: TOKEN, expires_in: '1.5' },
      { access_token: TOKEN, expires_in: 2.5 },
      { access_token: TOKEN, refresh_token: '' },
      { access_token: '' },
      { access_token: 42 },
      { expires_in: 3600 },
      { error: '' },
      { error: { code: 'nested' } },
      [TOKEN],
      'not json',
    ];
    for (const shape of shapes) {
      expect(failureOf(shape)).toMatchObject(INVALID);
    }
  });

  it('ACT-126 a 2xx that carries an error and no token is a refusal, as Zoho Books answers a spent refresh token', () => {
    expect(failureOf({ error: 'invalid_code' })).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_code' },
    });
    expect(failureOf({ access_token: '', error: 'invalid_client' })).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_client' },
    });
    expect(failureOf({ error: 'access_denied' })).toMatchObject({
      code: 'upstream_error',
      detail: { status: 200, error: 'access_denied' },
    });
    expect(failureOf({ error: 'not a code' }).detail).toStrictEqual({ status: 200 });
    expect(grantOf({ access_token: TOKEN, error: 'ignored' }).accessToken).toBe(TOKEN);
  });

  it('ACT-126 maps invalid_client, invalid_grant, unauthorized_client and invalid_code to authentication_failed with only the code', () => {
    for (const error of [
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'invalid_code',
    ]) {
      const failure = failureOf({ error, error_description: `denied for secret-${error}` }, 400);
      expect(failure.code).toBe('authentication_failed');
      expect(failure.detail).toStrictEqual({ error });
    }
  });

  it('ACT-126 maps any other refusal to upstream_error with the status and a well-formed code, never the description', () => {
    expect(
      failureOf({ error: 'temporarily_unavailable', error_description: 'echo refresh=abc' }, 503),
    ).toMatchObject({
      code: 'upstream_error',
      detail: { status: 503, error: 'temporarily_unavailable' },
    });
    expect(failureOf({ error: 'Invalid.Scope-2' }, 400).detail).toStrictEqual({
      status: 400,
      error: 'Invalid.Scope-2',
    });
    const refusedCodes: readonly unknown[] = [
      'has spaces',
      'slash/inside',
      'quote"',
      'x'.repeat(65),
      '',
      7,
    ];
    for (const error of refusedCodes) {
      expect(failureOf({ error, error_description: 'secret-in-here' }, 400).detail).toStrictEqual({
        status: 400,
      });
    }
    expect(
      failureOf({ status: 'BAD_REFRESH_TOKEN', message: 'unknown token' }, 400).detail,
    ).toStrictEqual({
      status: 400,
    });
    expect(failureOf('<html>gateway</html>', 502).detail).toStrictEqual({ status: 502 });
    expect(failureOf({ access_token: TOKEN }, 401).code).toBe('upstream_error');
    const longest = 'x'.repeat(64);
    expect(failureOf({ error: longest }, 400).detail).toStrictEqual({
      status: 400,
      error: longest,
    });
  });
});
