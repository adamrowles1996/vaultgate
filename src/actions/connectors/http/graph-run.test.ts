import { describe, expect, it } from 'vitest';

import {
  GRAPH_BASE_URL,
  GRAPH_CANARY,
  graphCredential,
  graphRequests,
  graphTransport,
  tokenFailure,
  tokenRequests,
  tokenResponse,
} from '../../../test-support/graph.ts';
import {
  echoResponse,
  httpConnectorOver,
  httpRunContext,
  textResponse as text,
} from '../../../test-support/http-connector.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { ActionError } from '../../errors.ts';

import type { HttpOperation } from './operation.ts';
import type { PinnedRequest } from '../../../net/pinned-https.ts';
import type {
  ContextOptions,
  Answer,
  FakeTransport,
} from '../../../test-support/http-connector.ts';

const GET_USERS: HttpOperation = { method: 'GET', path: '/users' };

const REFRESH_CREDENTIAL = graphCredential({
  grant: 'refresh_token',
  refresh_token_field: 'custom.refresh',
});

function graphContext(options: ContextOptions = {}): ContextOptions {
  return { baseUrl: GRAPH_BASE_URL, credential: graphCredential(), ...options };
}

async function runGraph(
  fake: FakeTransport,
  options: ContextOptions = {},
): Promise<
  ReturnType<typeof httpRunContext> & {
    readonly outcome: Awaited<ReturnType<ReturnType<typeof httpConnectorOver>['run']>>;
  }
> {
  const built = httpRunContext(graphContext(options));
  const outcome = await httpConnectorOver(fake).run(built.context, GET_USERS);
  return { ...built, outcome };
}

function authorizationOf(request: PinnedRequest | undefined): string | undefined {
  return request?.headers['authorization'];
}

function twoTokens(): (request: PinnedRequest, index: number) => Answer {
  const script = [tokenResponse(), tokenResponse({ accessToken: GRAPH_CANARY.secondAccessToken })];
  return (_request, index) => script[index] ?? tokenResponse();
}

describe('http_request on a graph target', () => {
  it('ACT-82 obtains a token and sends it as the Authorization header of the Graph request', async () => {
    const fake = graphTransport(twoTokens(), (request) => echoResponse(request));
    const { outcome } = await runGraph(fake);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 200 });
    expect(tokenRequests(fake)).toHaveLength(1);
    const [call] = graphRequests(fake);
    expect(call?.url).toBe('https://graph.microsoft.com/v1.0/users');
    expect(authorizationOf(call)).toBe(`Bearer ${GRAPH_CANARY.accessToken}`);
  });

  it('ACT-82 retries a 401 once with a fresh token and answers with the second response', async () => {
    const api = [text(401, 'expired'), text(200, 'ok')];
    const fake = graphTransport(twoTokens(), (_request, index) => api[index] ?? text(200, 'never'));
    const { outcome } = await runGraph(fake);
    expect(unwrapOk(outcome).captured['body']?.toString('utf8')).toBe('ok');
    expect(tokenRequests(fake)).toHaveLength(2);
    expect(graphRequests(fake).map((request) => authorizationOf(request))).toStrictEqual([
      `Bearer ${GRAPH_CANARY.accessToken}`,
      `Bearer ${GRAPH_CANARY.secondAccessToken}`,
    ]);
  });

  it('ACT-82 ACT-21 a 401 on the retry is the result, not a loop', async () => {
    const fake = graphTransport(twoTokens(), () => text(401, 'no'));
    const { outcome } = await runGraph(fake);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 401 });
    expect(tokenRequests(fake)).toHaveLength(2);
    expect(graphRequests(fake)).toHaveLength(2);
  });

  it('ACT-82 a fresh token the endpoint will not issue fails the retried call with the endpoint code', async () => {
    const token = [tokenResponse(), tokenFailure(400, 'invalid_client')];
    const fake = graphTransport(
      (_request, index) => token[index] ?? tokenResponse(),
      () => text(401, 'expired'),
    );
    const { outcome } = await runGraph(fake);
    expect(unwrapFail(outcome).code).toBe('authentication_failed');
    expect(graphRequests(fake)).toHaveLength(1);
  });

  it('ACT-82 a token endpoint that refuses the credential fails the call before Graph is touched', async () => {
    const fake = graphTransport(
      () => tokenFailure(401, 'invalid_grant'),
      () => text(200, 'never'),
    );
    const { outcome } = await runGraph(fake, { credential: REFRESH_CREDENTIAL });
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_grant' },
    });
    expect(graphRequests(fake)).toStrictEqual([]);
  });

  it('ACT-83 a failed refresh-token write-back fails the call and no Graph request is made', async () => {
    const fake = graphTransport(
      () => tokenResponse({ refreshToken: GRAPH_CANARY.rotatedRefreshToken }),
      () => text(200, 'never'),
    );
    const { outcome, support } = await runGraph(fake, {
      credential: REFRESH_CREDENTIAL,
      rotation: new ActionError('credential_rotation_failed', { reason: 'not_found' }),
    });
    expect(unwrapFail(outcome).code).toBe('credential_rotation_failed');
    expect(support.rotations).toHaveLength(1);
    expect(graphRequests(fake)).toStrictEqual([]);
  });
});
