import { describe, expect, it } from 'vitest';

import {
  EXPIRES_IN,
  formOf,
  GRAPH_CANARY,
  graphCredential,
  GRAPH_TENANT,
  tokenFailure,
  tokenResponse,
} from '../../../test-support/graph.ts';
import { scripted } from '../../../test-support/http-connector.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import {
  recordedSupport,
  type RecordedSupport,
  type SupportOptions,
} from '../../../test-support/run-support.ts';
import { ActionError } from '../../errors.ts';

import { ACCESS_TOKEN_FIELD, createGraphTokens, type GraphContext } from './adapter.ts';
import { TOKEN_MARGIN_MS } from './cache.ts';

import type { GraphCredential } from './document.ts';
import type { Answer, FakeTransport } from '../../../test-support/http-connector.ts';

const SECRET = 'client-secret-value';
const REFRESH = 'stored-refresh-token';
const HOUR_MS = EXPIRES_IN * 1000;

const REFRESH_CREDENTIAL = graphCredential({
  grant: 'refresh_token',
  refresh_token_field: 'custom.refresh',
});

interface Built {
  readonly context: GraphContext;
  readonly support: RecordedSupport;
}

function contextFor(
  credential: GraphCredential = graphCredential(),
  options: SupportOptions = {},
): Built {
  const support = recordedSupport({
    entries: [
      { field: credential.secret_field, value: Buffer.from(SECRET, 'utf8') },
      { field: 'custom.refresh', value: Buffer.from(REFRESH, 'utf8') },
    ],
    ...options,
  });
  return {
    support,
    context: {
      credential,
      injected: support.secrets.injected,
      support: support.support,
      signal: new AbortController().signal,
    },
  };
}

interface Clock {
  now: number;
}

function tokensOver(fake: FakeTransport, clock: Clock): ReturnType<typeof createGraphTokens> {
  return createGraphTokens({ transport: fake.transport, now: () => clock.now, version: '9.9.9' });
}

function answers(...script: readonly Answer[]): FakeTransport {
  return scripted(script);
}

describe('the graph credential adapter', () => {
  it('ACT-82 ACT-55 obtains a token for the client-credentials grant and adds it to the scrub table', async () => {
    const fake = answers(tokenResponse());
    const { context, support } = contextFor();
    const token = await tokensOver(fake, { now: 0 }).accessToken(context, false);
    expect(unwrapOk(token)).toBe(GRAPH_CANARY.accessToken);
    expect(support.resolved).toStrictEqual(['login.microsoftonline.com']);
    expect(support.captured).toStrictEqual([
      { field: ACCESS_TOKEN_FIELD, value: GRAPH_CANARY.accessToken },
    ]);
    expect(support.secrets.scrub.text(GRAPH_CANARY.accessToken)).toBe(
      `[redacted:${ACCESS_TOKEN_FIELD}]`,
    );
    expect(formOf(fake.requests[0]!).get('client_secret')).toBe(SECRET);
    expect(new URL(fake.requests[0]!.url).pathname).toBe(`/${GRAPH_TENANT}/oauth2/v2.0/token`);
  });

  it('ACT-82 serves a second call from the cache, and asks again once the 60 s margin is reached', async () => {
    const fake = answers(
      tokenResponse(),
      tokenResponse({ accessToken: GRAPH_CANARY.secondAccessToken }),
    );
    const clock: Clock = { now: 0 };
    const tokens = tokensOver(fake, clock);
    const { context } = contextFor();
    expect(unwrapOk(await tokens.accessToken(context, false))).toBe(GRAPH_CANARY.accessToken);
    clock.now = HOUR_MS - TOKEN_MARGIN_MS - 1;
    expect(unwrapOk(await tokens.accessToken(context, false))).toBe(GRAPH_CANARY.accessToken);
    expect(fake.requests).toHaveLength(1);
    clock.now = HOUR_MS - TOKEN_MARGIN_MS;
    expect(unwrapOk(await tokens.accessToken(context, false))).toBe(GRAPH_CANARY.secondAccessToken);
    expect(fake.requests).toHaveLength(2);
  });

  it('ACT-82 a changed revision and an explicit retry both discard the cached token', async () => {
    const fake = answers(
      tokenResponse(),
      tokenResponse({ accessToken: 'second' }),
      tokenResponse({ accessToken: 'third' }),
    );
    const tokens = tokensOver(fake, { now: 0 });
    const first = contextFor();
    expect(unwrapOk(await tokens.accessToken(first.context, false))).toBe(GRAPH_CANARY.accessToken);
    const edited = contextFor(graphCredential(), { target: { revision: 2 } });
    expect(unwrapOk(await tokens.accessToken(edited.context, false))).toBe('second');
    expect(unwrapOk(await tokens.accessToken(edited.context, true))).toBe('third');
    expect(fake.requests).toHaveLength(3);
  });

  it('ACT-83 writes a rotated refresh token back before returning the token, and scrubs it too', async () => {
    const fake = answers(tokenResponse({ refreshToken: GRAPH_CANARY.rotatedRefreshToken }));
    const { context, support } = contextFor(REFRESH_CREDENTIAL);
    expect(unwrapOk(await tokensOver(fake, { now: 0 }).accessToken(context, false))).toBe(
      GRAPH_CANARY.accessToken,
    );
    expect(formOf(fake.requests[0]!).get('refresh_token')).toBe(REFRESH);
    expect(support.rotations).toStrictEqual([
      { field: 'custom.refresh', value: GRAPH_CANARY.rotatedRefreshToken },
    ]);
    expect(support.secrets.scrub.text(GRAPH_CANARY.rotatedRefreshToken)).toBe(
      '[redacted:custom.refresh]',
    );
  });

  it('ACT-83 a write-back that fails fails the call, so the operator learns before the old token expires', async () => {
    const fake = answers(tokenResponse({ refreshToken: GRAPH_CANARY.rotatedRefreshToken }));
    const { context, support } = contextFor(REFRESH_CREDENTIAL, {
      rotation: new ActionError('credential_rotation_failed', { reason: 'vault_unavailable' }),
    });
    const outcome = await tokensOver(fake, { now: 0 }).accessToken(context, false);
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'credential_rotation_failed',
      detail: { reason: 'vault_unavailable' },
    });
    expect(support.rotations).toHaveLength(1);
  });

  it('ACT-83 nothing is written back when the token endpoint kept the refresh token', async () => {
    const fake = answers(tokenResponse());
    const { context, support } = contextFor(REFRESH_CREDENTIAL);
    expect(unwrapOk(await tokensOver(fake, { now: 0 }).accessToken(context, false))).toBe(
      GRAPH_CANARY.accessToken,
    );
    expect(support.rotations).toStrictEqual([]);
  });

  it('ACT-54 answers credential_unavailable when the vault held no client secret or no refresh token', async () => {
    const fake = answers(tokenResponse());
    const missingSecret = recordedSupport({ entries: [] });
    const withoutSecret: GraphContext = {
      credential: graphCredential(),
      injected: missingSecret.secrets.injected,
      support: missingSecret.support,
      signal: new AbortController().signal,
    };
    expect(
      unwrapFail(await tokensOver(fake, { now: 0 }).accessToken(withoutSecret, false)).code,
    ).toBe('credential_unavailable');
    const onlySecret = recordedSupport({
      entries: [{ field: 'password', value: Buffer.from(SECRET, 'utf8') }],
    });
    const withoutRefresh: GraphContext = {
      credential: REFRESH_CREDENTIAL,
      injected: onlySecret.secrets.injected,
      support: onlySecret.support,
      signal: new AbortController().signal,
    };
    expect(
      unwrapFail(await tokensOver(fake, { now: 0 }).accessToken(withoutRefresh, false)).code,
    ).toBe('credential_unavailable');
    expect(fake.requests).toStrictEqual([]);
  });

  it('ACT-55 ACT-82 a token endpoint that will not resolve or answers an error fails the call unchanged', async () => {
    const refused = contextFor(graphCredential(), {
      resolution: new ActionError('destination_refused', { reason: 'private' }),
    });
    const quiet = answers(tokenResponse());
    expect(
      unwrapFail(await tokensOver(quiet, { now: 0 }).accessToken(refused.context, false)).code,
    ).toBe('destination_refused');
    expect(quiet.requests).toStrictEqual([]);
    const failing = answers(tokenFailure(401, 'invalid_client'));
    const { context } = contextFor();
    expect(unwrapFail(await tokensOver(failing, { now: 0 }).accessToken(context, false)).code).toBe(
      'authentication_failed',
    );
  });
});
