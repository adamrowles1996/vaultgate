import { describe, expect, it } from 'vitest';

import {
  echoResponse,
  httpConnectorOver,
  httpRunContext,
  redirectResponse,
  textResponse as text,
} from '../../../test-support/http-connector.ts';
import {
  apiRequests,
  OAUTH2_BASE_URL,
  OAUTH2_CANARY,
  oauth2Credential,
  oauth2Grant,
  oauth2RefreshCredential,
  oauth2TokenRequests,
  oauth2Transport,
  refusedWithOk,
} from '../../../test-support/oauth2.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { ActionError } from '../../errors.ts';

import type { HttpOperation } from './operation.ts';
import type { PinnedRequest } from '../../../net/pinned-https.ts';
import type {
  Answer,
  ContextOptions,
  FakeTransport,
} from '../../../test-support/http-connector.ts';

const GET_INVOICES: HttpOperation = { method: 'GET', path: '/invoices?organization_id=10234' };

async function runOAuth2(
  fake: FakeTransport,
  options: ContextOptions = {},
): Promise<
  ReturnType<typeof httpRunContext> & {
    readonly outcome: Awaited<ReturnType<ReturnType<typeof httpConnectorOver>['run']>>;
  }
> {
  const built = httpRunContext({
    baseUrl: OAUTH2_BASE_URL,
    credential: oauth2Credential(),
    ...options,
  });
  const outcome = await httpConnectorOver(fake).run(built.context, GET_INVOICES);
  return { ...built, outcome };
}

function twoTokens(): (request: PinnedRequest, index: number) => Answer {
  const script = [
    oauth2Grant({ expires_in: 3600 }),
    oauth2Grant({ access_token: OAUTH2_CANARY.secondAccessToken, expires_in: 3600 }),
  ];
  return (_request, index) => script[index] ?? oauth2Grant();
}

function headersOf(fake: FakeTransport, name: string): readonly (string | undefined)[] {
  return apiRequests(fake).map((request) => request.headers[name]);
}

describe('http_request on an oauth2 target', () => {
  it('ACT-128 ACT-125 obtains a token and sends it as Authorization: Bearer by default', async () => {
    const fake = oauth2Transport(twoTokens(), (request) => echoResponse(request));
    const { outcome, support } = await runOAuth2(fake);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 200 });
    expect(oauth2TokenRequests(fake)).toHaveLength(1);
    const [call] = apiRequests(fake);
    expect(call?.url).toBe('https://api.example.com/v1/invoices?organization_id=10234');
    expect(call?.headers['authorization']).toBe(`Bearer ${OAUTH2_CANARY.accessToken}`);
    expect(support.resolved).toStrictEqual(['auth.example.com']);
  });

  it('ACT-128 injects <name>: <prefix><token>, as Zoho Books and a custom header want it', async () => {
    const zoho = oauth2Transport(twoTokens(), () => text(200, 'ok'));
    await runOAuth2(zoho, { credential: oauth2Credential({ prefix: 'Zoho-oauthtoken ' }) });
    expect(headersOf(zoho, 'authorization')).toStrictEqual([
      `Zoho-oauthtoken ${OAUTH2_CANARY.accessToken}`,
    ]);
    const custom = oauth2Transport(twoTokens(), () => text(200, 'ok'));
    await runOAuth2(custom, {
      credential: oauth2Credential({ name: 'X-Access-Token', prefix: '' }),
    });
    expect(headersOf(custom, 'x-access-token')).toStrictEqual([OAUTH2_CANARY.accessToken]);
    expect(headersOf(custom, 'authorization')).toStrictEqual([undefined]);
  });

  it('ACT-128 ACT-22 carries the token again on a redirect hop that stays under base_url', async () => {
    const api = [redirectResponse(302, '/v1/invoices/page-2'), text(200, 'second page')];
    const fake = oauth2Transport(
      twoTokens(),
      (_request, index) => api[index] ?? text(200, 'never'),
    );
    const { outcome } = await runOAuth2(fake, { policy: { follow_redirects: true } });
    expect(unwrapOk(outcome).captured['body']?.toString('utf8')).toBe('second page');
    expect(headersOf(fake, 'authorization')).toStrictEqual([
      `Bearer ${OAUTH2_CANARY.accessToken}`,
      `Bearer ${OAUTH2_CANARY.accessToken}`,
    ]);
    expect(oauth2TokenRequests(fake)).toHaveLength(1);
  });

  it('ACT-129 retries a 401 once with a fresh token and answers with the second response', async () => {
    const api = [text(401, 'expired'), text(200, 'ok')];
    const fake = oauth2Transport(
      twoTokens(),
      (_request, index) => api[index] ?? text(200, 'never'),
    );
    const { outcome } = await runOAuth2(fake);
    expect(unwrapOk(outcome).captured['body']?.toString('utf8')).toBe('ok');
    expect(oauth2TokenRequests(fake)).toHaveLength(2);
    expect(headersOf(fake, 'authorization')).toStrictEqual([
      `Bearer ${OAUTH2_CANARY.accessToken}`,
      `Bearer ${OAUTH2_CANARY.secondAccessToken}`,
    ]);
  });

  it('ACT-129 ACT-21 a 401 on the retry is the result, not a loop', async () => {
    const fake = oauth2Transport(twoTokens(), () => text(401, 'no'));
    const { outcome } = await runOAuth2(fake);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 401 });
    expect(oauth2TokenRequests(fake)).toHaveLength(2);
    expect(apiRequests(fake)).toHaveLength(2);
  });

  it('ACT-129 ACT-126 a fresh token the endpoint will not issue fails the retried call with the endpoint code', async () => {
    const token = [oauth2Grant(), refusedWithOk('invalid_code')];
    const fake = oauth2Transport(
      (_request, index) => token[index] ?? oauth2Grant(),
      () => text(401, 'expired'),
    );
    const { outcome } = await runOAuth2(fake, { credential: oauth2RefreshCredential() });
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_code' },
    });
    expect(apiRequests(fake)).toHaveLength(1);
  });

  it('ACT-126 a token endpoint that refuses the client fails the call before the API is touched', async () => {
    const fake = oauth2Transport(
      () => Response.json({ error: 'unauthorized_client' }, { status: 400 }),
      () => text(200, 'never'),
    );
    const { outcome } = await runOAuth2(fake);
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'unauthorized_client' },
    });
    expect(apiRequests(fake)).toStrictEqual([]);
  });

  it('ACT-127 a failed refresh-token write-back fails the call and no API request is made', async () => {
    const fake = oauth2Transport(
      () => oauth2Grant({ refresh_token: OAUTH2_CANARY.rotatedRefreshToken }),
      () => text(200, 'never'),
    );
    const { outcome, support } = await runOAuth2(fake, {
      credential: oauth2RefreshCredential(),
      rotation: new ActionError('credential_rotation_failed', { reason: 'not_found' }),
    });
    expect(unwrapFail(outcome).code).toBe('credential_rotation_failed');
    expect(support.rotations).toHaveLength(1);
    expect(apiRequests(fake)).toStrictEqual([]);
  });
});
