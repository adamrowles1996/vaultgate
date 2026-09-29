import { describe, expect, it } from 'vitest';

import { formOf } from '../../../test-support/graph.ts';
import { scripted } from '../../../test-support/http-connector.ts';
import {
  OAUTH2_CANARY,
  OAUTH2_CLIENT,
  OAUTH2_TOKEN_URL,
  oauth2Credential,
  oauth2Grant,
  oauth2RefreshCredential,
  refusedWithOk,
} from '../../../test-support/oauth2.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { SUPPORT_ADDRESS } from '../../../test-support/run-support.ts';

import { exchangePlan } from './exchange.ts';
import { requestToken, type TokenRequest } from './token.ts';

import type { OAuth2Credential } from './oauth2-document.ts';
import type { PinnedRequest } from '../../../net/pinned-https.ts';

const SECRET = 'client-secret-value';

async function posted(
  credential: OAuth2Credential,
  overrides: Partial<TokenRequest> = {},
  answer: Response = oauth2Grant({ expires_in: 3600 }),
): Promise<{
  readonly request: PinnedRequest;
  readonly outcome: Awaited<ReturnType<typeof requestToken>>;
}> {
  const fake = scripted([answer]);
  const outcome = await requestToken(fake.transport, {
    plan: exchangePlan(credential),
    clientSecret: SECRET,
    refreshToken: undefined,
    address: SUPPORT_ADDRESS,
    signal: new AbortController().signal,
    version: '9.9.9',
    ...overrides,
  });
  const [request] = fake.requests;
  if (request === undefined) {
    throw new Error('no token request was made');
  }
  return { request, outcome };
}

describe('the oauth2 token exchange', () => {
  it('ACT-125 posts the client-credentials form to token_url at the pinned address, the client in the form and no scope unless set', async () => {
    const { request, outcome } = await posted(oauth2Credential());
    expect(request).toMatchObject({
      url: OAUTH2_TOKEN_URL,
      address: SUPPORT_ADDRESS,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'vaultgate/9.9.9',
      },
    });
    expect(request.headers['authorization']).toBeUndefined();
    expect([...formOf(request)]).toStrictEqual([
      ['client_id', OAUTH2_CLIENT],
      ['client_secret', SECRET],
      ['grant_type', 'client_credentials'],
    ]);
    expect(unwrapOk(outcome)).toStrictEqual({
      accessToken: OAUTH2_CANARY.accessToken,
      expiresInMs: 3_600_000,
      refreshToken: undefined,
    });
  });

  it('ACT-125 sends the scope when the document sets one', async () => {
    const scope = 'https://analysis.windows.net/powerbi/api/.default';
    const { request } = await posted(oauth2Credential({ scope }));
    expect([...formOf(request)]).toStrictEqual([
      ['client_id', OAUTH2_CLIENT],
      ['client_secret', SECRET],
      ['scope', scope],
      ['grant_type', 'client_credentials'],
    ]);
  });

  it('ACT-125 authenticates the client with HTTP Basic over the form-urlencoded id and secret, and keeps both out of the form', async () => {
    const { request } = await posted(
      oauth2RefreshCredential({ client_auth: 'basic', client_id: 'app:one' }),
      { clientSecret: 'p@ss word+/=:', refreshToken: 'the-current-refresh-token' },
    );
    const pair = 'app%3Aone:p%40ss+word%2B%2F%3D%3A';
    expect(request.headers['authorization']).toBe(
      `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
    );
    expect([...formOf(request)]).toStrictEqual([
      ['grant_type', 'refresh_token'],
      ['refresh_token', 'the-current-refresh-token'],
    ]);
  });

  it('ACT-125 ACT-126 answers a refresh with the token the endpoint returned, and a 200 refusal as the refusal it is', async () => {
    const rotated = await posted(
      oauth2RefreshCredential(),
      { refreshToken: 'the-current-refresh-token' },
      oauth2Grant({ expires_in: '3600', refresh_token: OAUTH2_CANARY.rotatedRefreshToken }),
    );
    expect(formOf(rotated.request).get('refresh_token')).toBe('the-current-refresh-token');
    expect(unwrapOk(rotated.outcome)).toStrictEqual({
      accessToken: OAUTH2_CANARY.accessToken,
      expiresInMs: 3_600_000,
      refreshToken: OAUTH2_CANARY.rotatedRefreshToken,
    });
    const refused = await posted(
      oauth2RefreshCredential(),
      { refreshToken: 'spent' },
      refusedWithOk('invalid_code'),
    );
    expect(unwrapFail(refused.outcome)).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_code' },
    });
  });
});
