import { describe, expect, it } from 'vitest';

import { formOf } from '../../../test-support/graph.ts';
import { scripted } from '../../../test-support/http-connector.ts';
import {
  OAUTH2_CANARY,
  OAUTH2_TOKEN_HOST,
  oauth2Credential,
  oauth2Grant,
  oauth2RefreshCredential,
  refusedWithOk,
} from '../../../test-support/oauth2.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import {
  recordedSupport,
  type RecordedSupport,
  type SupportOptions,
} from '../../../test-support/run-support.ts';
import { ActionError } from '../../errors.ts';

import { createTokenService, type TokenContext, type TokenService } from './adapter.ts';
import { TOKEN_MARGIN_MS } from './cache.ts';
import { OAUTH2_ACCESS_TOKEN_FIELD } from './exchange.ts';

import type { OAuth2Credential } from './oauth2-document.ts';
import type { Answer, FakeTransport } from '../../../test-support/http-connector.ts';

const SECRET = 'client-secret-value';
const REFRESH = 'stored-refresh-token';
const DEFAULT_LIFETIME_MS = 300_000;

interface Built {
  readonly context: TokenContext;
  readonly support: RecordedSupport;
}

function contextFor(
  credential: OAuth2Credential = oauth2Credential(),
  options: SupportOptions = {},
): Built {
  const support = recordedSupport({
    entries: [
      { field: 'password', value: Buffer.from(SECRET, 'utf8') },
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

function stopped(): Clock {
  return { now: 0 };
}

function serviceOver(fake: FakeTransport, clock: Clock = stopped()): TokenService {
  return createTokenService({ transport: fake.transport, now: () => clock.now, version: '9.9.9' });
}

function answers(...script: readonly Answer[]): FakeTransport {
  return scripted(script);
}

describe('the oauth2 credential adapter', () => {
  it('ACT-125 ACT-128 resolves the token host for the exchange and adds the token to the scrub table as oauth2.access_token', async () => {
    const fake = answers(oauth2Grant({ expires_in: 3600 }));
    const { context, support } = contextFor();
    expect(unwrapOk(await serviceOver(fake).accessToken(context, false))).toBe(
      OAUTH2_CANARY.accessToken,
    );
    expect(support.resolved).toStrictEqual([OAUTH2_TOKEN_HOST]);
    expect(support.captured).toStrictEqual([
      { field: OAUTH2_ACCESS_TOKEN_FIELD, value: OAUTH2_CANARY.accessToken },
    ]);
    expect(support.secrets.scrub.text(`Bearer ${OAUTH2_CANARY.accessToken}`)).toBe(
      'Bearer [redacted:oauth2.access_token]',
    );
    expect(formOf(fake.requests[0]!).get('client_secret')).toBe(SECRET);
  });

  it('ACT-129 serves the cached token until 60 s before expires_in, and a missing expires_in lasts 300 s', async () => {
    const fake = answers(
      oauth2Grant(),
      oauth2Grant({ access_token: OAUTH2_CANARY.secondAccessToken, expires_in: '3600' }),
    );
    const clock: Clock = { now: 0 };
    const service = serviceOver(fake, clock);
    const { context, support } = contextFor();
    expect(unwrapOk(await service.accessToken(context, false))).toBe(OAUTH2_CANARY.accessToken);
    clock.now = DEFAULT_LIFETIME_MS - TOKEN_MARGIN_MS - 1;
    expect(unwrapOk(await service.accessToken(context, false))).toBe(OAUTH2_CANARY.accessToken);
    expect(fake.requests).toHaveLength(1);
    clock.now = DEFAULT_LIFETIME_MS - TOKEN_MARGIN_MS;
    expect(unwrapOk(await service.accessToken(context, false))).toBe(
      OAUTH2_CANARY.secondAccessToken,
    );
    expect(fake.requests).toHaveLength(2);
    // ACT-125: a call served from the cache exchanges nothing and resolves nothing.
    expect(support.resolved).toStrictEqual([OAUTH2_TOKEN_HOST, OAUTH2_TOKEN_HOST]);
  });

  it('ACT-129 a changed revision and an explicit retry both discard the cached token', async () => {
    const fake = answers(
      oauth2Grant({ expires_in: 3600 }),
      oauth2Grant({ access_token: 'second', expires_in: 3600 }),
      oauth2Grant({ access_token: 'third', expires_in: 3600 }),
    );
    const service = serviceOver(fake);
    const { context } = contextFor();
    expect(unwrapOk(await service.accessToken(context, false))).toBe(OAUTH2_CANARY.accessToken);
    const edited = contextFor(oauth2Credential(), { target: { revision: 2 } });
    expect(unwrapOk(await service.accessToken(edited.context, false))).toBe('second');
    expect(unwrapOk(await service.accessToken(edited.context, false))).toBe('second');
    expect(unwrapOk(await service.accessToken(edited.context, true))).toBe('third');
    expect(fake.requests).toHaveLength(3);
  });

  it('ACT-127 writes a changed refresh token back before returning the token, and scrubs it', async () => {
    const fake = answers(oauth2Grant({ refresh_token: OAUTH2_CANARY.rotatedRefreshToken }));
    const { context, support } = contextFor(oauth2RefreshCredential());
    expect(unwrapOk(await serviceOver(fake).accessToken(context, false))).toBe(
      OAUTH2_CANARY.accessToken,
    );
    expect(formOf(fake.requests[0]!).get('refresh_token')).toBe(REFRESH);
    expect(support.rotations).toStrictEqual([
      { field: 'custom.refresh', value: OAUTH2_CANARY.rotatedRefreshToken },
    ]);
    expect(support.secrets.scrub.text(OAUTH2_CANARY.rotatedRefreshToken)).toBe(
      '[redacted:custom.refresh]',
    );
    expect(support.secrets.injected.value('custom.refresh')?.toString('utf8')).toBe(
      OAUTH2_CANARY.rotatedRefreshToken,
    );
  });

  it('ACT-127 writes nothing when the endpoint returns the refresh token the call holds, or none at all', async () => {
    const fake = answers(oauth2Grant({ refresh_token: REFRESH }), oauth2Grant());
    const service = serviceOver(fake);
    const { context, support } = contextFor(oauth2RefreshCredential());
    expect(unwrapOk(await service.accessToken(context, false))).toBe(OAUTH2_CANARY.accessToken);
    expect(unwrapOk(await service.accessToken(context, true))).toBe(OAUTH2_CANARY.accessToken);
    expect(fake.requests).toHaveLength(2);
    expect(support.rotations).toStrictEqual([]);
  });

  it('ACT-127 a write-back that fails fails the call with credential_rotation_failed', async () => {
    const fake = answers(oauth2Grant({ refresh_token: OAUTH2_CANARY.rotatedRefreshToken }));
    const { context, support } = contextFor(oauth2RefreshCredential(), {
      rotation: new ActionError('credential_rotation_failed', { reason: 'unwritable_field' }),
    });
    const outcome = await serviceOver(fake).accessToken(context, false);
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'credential_rotation_failed',
      detail: { reason: 'unwritable_field' },
    });
    expect(support.rotations).toHaveLength(1);
    // Scrubbed before the write was attempted, so a failed write cannot leak it either.
    expect(support.secrets.scrub.text(OAUTH2_CANARY.rotatedRefreshToken)).toBe(
      '[redacted:custom.refresh]',
    );
  });

  it('ACT-127 a client-credentials grant writes nothing back even when the endpoint volunteers a refresh token', async () => {
    const fake = answers(oauth2Grant({ refresh_token: OAUTH2_CANARY.rotatedRefreshToken }));
    const { context, support } = contextFor();
    expect(unwrapOk(await serviceOver(fake).accessToken(context, false))).toBe(
      OAUTH2_CANARY.accessToken,
    );
    expect(formOf(fake.requests[0]!).has('refresh_token')).toBe(false);
    expect(support.rotations).toStrictEqual([]);
  });

  it('ACT-54 answers credential_unavailable without a client secret, a refresh token or a refresh-token field, and asks nothing', async () => {
    const fake = answers(oauth2Grant());
    const service = serviceOver(fake);
    const empty = contextFor(oauth2RefreshCredential(), { entries: [] });
    expect(unwrapFail(await service.accessToken(empty.context, false)).code).toBe(
      'credential_unavailable',
    );
    const onlySecret = contextFor(oauth2RefreshCredential(), {
      entries: [{ field: 'password', value: Buffer.from(SECRET, 'utf8') }],
    });
    expect(unwrapFail(await service.accessToken(onlySecret.context, false)).code).toBe(
      'credential_unavailable',
    );
    const unmapped: OAuth2Credential = { ...oauth2Credential(), grant: 'refresh_token' };
    const withoutField = contextFor(unmapped).context;
    expect(unwrapFail(await service.accessToken(withoutField, false)).code).toBe(
      'credential_unavailable',
    );
    expect(fake.requests).toStrictEqual([]);
  });

  it('ACT-125 ACT-126 a token host that will not resolve, or an endpoint that refuses in a 200, fails the call unchanged', async () => {
    const quiet = answers(oauth2Grant());
    const refused = contextFor(oauth2Credential(), {
      resolution: new ActionError('destination_refused', { reason: 'private' }),
    });
    expect(unwrapFail(await serviceOver(quiet).accessToken(refused.context, false))).toMatchObject({
      code: 'destination_refused',
      detail: { reason: 'private' },
    });
    expect(quiet.requests).toStrictEqual([]);
    const zoho = answers(refusedWithOk('invalid_code'));
    const { context } = contextFor(oauth2RefreshCredential());
    expect(unwrapFail(await serviceOver(zoho).accessToken(context, false))).toMatchObject({
      code: 'authentication_failed',
      detail: { error: 'invalid_code' },
    });
  });
});
