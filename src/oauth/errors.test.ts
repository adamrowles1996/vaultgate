import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  OAuthError,
  oauthErrorBody,
  oauthErrorStatus,
  respondRateLimited,
  respondWithOAuthError,
} from './errors.ts';

describe('OAuthError', () => {
  it('OAUTH-27 carries an RFC 6749 §5.2 code and a client-facing description', () => {
    const error = new OAuthError('invalid_grant', 'the code has expired');
    expect(error.name).toBe('OAuthError');
    expect(error.message).toBe('invalid_grant: the code has expired');
    expect(oauthErrorBody(error)).toStrictEqual({
      error: 'invalid_grant',
      error_description: 'the code has expired',
    });
  });

  it('OAUTH-27 maps codes to status: 400 by default, 401 for invalid_client, 429 when throttled', () => {
    expect(oauthErrorStatus(new OAuthError('invalid_request', 'x'))).toBe(400);
    expect(oauthErrorStatus(new OAuthError('invalid_client', 'x'))).toBe(401);
    expect(oauthErrorStatus(new OAuthError('temporarily_unavailable', 'x'))).toBe(429);
  });
});

describe('respondWithOAuthError', () => {
  it('OAUTH-26 answers JSON with Cache-Control: no-store', async () => {
    const app = new Hono().get('/', (context) =>
      respondWithOAuthError(context, new OAuthError('invalid_scope', 'no')),
    );
    const response = await app.request('/');
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toStrictEqual({
      error: 'invalid_scope',
      error_description: 'no',
    });
  });
});

describe('respondRateLimited', () => {
  it('OAUTH-28 answers 429 with Retry-After', async () => {
    const app = new Hono().get('/', (context) => respondRateLimited(context, 17));
    const response = await app.request('/');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(await response.json()).toStrictEqual({
      error: 'temporarily_unavailable',
      error_description: 'rate limit exceeded; retry later',
    });
  });
});
