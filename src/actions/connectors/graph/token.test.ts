import { describe, expect, it } from 'vitest';

import {
  EXPIRES_IN,
  formOf,
  GRAPH_CANARY,
  GRAPH_CLIENT,
  graphCredential,
  TOKEN_URL,
  tokenFailure,
  tokenResponse,
} from '../../../test-support/graph.ts';
import { coded, scripted } from '../../../test-support/http-connector.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { SUPPORT_ADDRESS } from '../../../test-support/run-support.ts';

import { requestToken, tokenUrl, type TokenRequest, type TokenGrant } from './token.ts';

import type { Result } from '../../../result.ts';
import type { Answer, FakeTransport } from '../../../test-support/http-connector.ts';
import type { ActionError } from '../../errors.ts';

const CLIENT_SECRET = 'client-secret-value';

function requestFor(overrides: Partial<TokenRequest> = {}): TokenRequest {
  return {
    credential: graphCredential(),
    clientSecret: CLIENT_SECRET,
    refreshToken: undefined,
    address: SUPPORT_ADDRESS,
    signal: new AbortController().signal,
    version: '9.9.9',
    ...overrides,
  };
}

async function exchange(
  answer: Answer,
  overrides: Partial<TokenRequest> = {},
): Promise<{ readonly fake: FakeTransport; readonly outcome: Result<TokenGrant, ActionError> }> {
  const fake = scripted([answer]);
  return { fake, outcome: await requestToken(fake.transport, requestFor(overrides)) };
}

async function failureOf(
  answer: Answer,
  overrides: Partial<TokenRequest> = {},
): Promise<ActionError> {
  const { outcome } = await exchange(answer, overrides);
  return unwrapFail(outcome);
}

describe('the graph token exchange', () => {
  it('ACT-82 ACT-55 posts the client-credentials form to the tenant token endpoint at the pinned address', async () => {
    const { fake, outcome } = await exchange(tokenResponse());
    const [request] = fake.requests;
    expect(request).toMatchObject({
      url: TOKEN_URL,
      address: SUPPORT_ADDRESS,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'vaultgate/9.9.9',
      },
    });
    expect([...formOf(request!)]).toStrictEqual([
      ['client_id', GRAPH_CLIENT],
      ['client_secret', CLIENT_SECRET],
      ['scope', 'https://graph.microsoft.com/.default'],
      ['grant_type', 'client_credentials'],
    ]);
    expect(unwrapOk(outcome)).toStrictEqual({
      accessToken: GRAPH_CANARY.accessToken,
      expiresInMs: EXPIRES_IN * 1000,
      rotatedRefreshToken: undefined,
    });
  });

  it('ACT-82 ACT-83 sends the refresh-token grant with the current token and reports the rotated one', async () => {
    const { fake, outcome } = await exchange(
      tokenResponse({ refreshToken: GRAPH_CANARY.rotatedRefreshToken }),
      {
        credential: graphCredential({
          grant: 'refresh_token',
          refresh_token_field: 'custom.refresh',
        }),
        refreshToken: 'the-current-refresh-token',
      },
    );
    expect(formOf(fake.requests[0]!).get('refresh_token')).toBe('the-current-refresh-token');
    expect(formOf(fake.requests[0]!).get('grant_type')).toBe('refresh_token');
    expect(unwrapOk(outcome).rotatedRefreshToken).toBe(GRAPH_CANARY.rotatedRefreshToken);
  });

  it('ACT-82 escapes the tenant into the path', () => {
    expect(tokenUrl('contoso.onmicrosoft.com')).toBe(TOKEN_URL);
  });

  it('ACT-82 maps invalid_client and invalid_grant to authentication_failed, keeping the code and not the AADSTS text', async () => {
    for (const error of ['invalid_client', 'invalid_grant']) {
      const failure = await failureOf(tokenFailure(401, error));
      expect(failure.code).toBe('authentication_failed');
      expect(failure.detail).toStrictEqual({ error });
      expect(JSON.stringify(failure.detail)).not.toContain('AADSTS');
    }
  });

  it('ACT-82 maps any other token-endpoint answer to upstream_error with the status and, when it has one, the code', async () => {
    expect(await failureOf(tokenFailure(400, 'unauthorized_client'))).toMatchObject({
      code: 'upstream_error',
      detail: { status: 400, error: 'unauthorized_client' },
    });
    expect(await failureOf(tokenFailure(503, undefined))).toMatchObject({
      code: 'upstream_error',
      detail: { status: 503 },
    });
    const gateway = await failureOf(new Response('<html>gateway</html>', { status: 502 }));
    expect(gateway.detail).toStrictEqual({ status: 502 });
  });

  it('T33 ACT-82 refuses a 200 whose body is not a token response rather than reading a field off it', async () => {
    const shapes = [
      Response.json({ access_token: '', expires_in: 3600 }),
      Response.json({ access_token: 'a', expires_in: -1 }),
      Response.json({ expires_in: 3600 }),
      new Response('not json', { status: 200 }),
    ];
    for (const shape of shapes) {
      expect(await failureOf(shape)).toMatchObject({
        code: 'upstream_error',
        detail: { reason: 'invalid_token_response' },
      });
    }
  });

  it('ACT-82 ACT-57 maps a transport failure to the same codes an http request gets', async () => {
    expect(await failureOf(coded('certificate expired', 'CERT_HAS_EXPIRED'))).toMatchObject({
      code: 'tls_error',
      detail: { reason: 'CERT_HAS_EXPIRED' },
    });
    expect(await failureOf(coded('refused', 'ECONNREFUSED'))).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'ECONNREFUSED' },
    });
  });

  it('ACT-59 an aborted exchange is the call timeout, not a connection failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await failureOf('hang', { signal: controller.signal });
    expect(failure.code).toBe('timeout');
  });
});
