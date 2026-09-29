import { describe, expect, it } from 'vitest';

import {
  caller,
  createHttpTarget,
  errorOf,
  httpInvocation,
  resultOf,
  storedCalls,
} from '../../../test-support/actions-fixtures.ts';
import { echoResponse, harnessOver, surfaces } from '../../../test-support/http-connector.ts';
import {
  isOAuth2TokenRequest,
  OAUTH2_BASE_URL,
  OAUTH2_CANARY,
  OAUTH2_CLIENT,
  OAUTH2_TOKEN_HOST,
  OAUTH2_TOKEN_URL,
  oauth2Grant,
  oauth2TokenRequests,
} from '../../../test-support/oauth2.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { scrubVariants } from '../../scrub.ts';

import { OAUTH2_ACCESS_TOKEN_FIELD } from './exchange.ts';

import type { PinnedRequest } from '../../../net/pinned-https.ts';

const REFRESH_FIELD = 'custom.API key';

const MAPPING = {
  mode: 'oauth2',
  token_url: OAUTH2_TOKEN_URL,
  grant: 'refresh_token',
  client_id: OAUTH2_CLIENT,
  secret_field: 'password',
  refresh_token_field: REFRESH_FIELD,
  prefix: 'Zoho-oauthtoken ',
};

const ROTATING = { refresh_token: OAUTH2_CANARY.rotatedRefreshToken };

/**
The token request as a hostile token endpoint might repeat it: its form and every header, Basic included.
*/
function echoed(request: PinnedRequest): Record<string, unknown> {
  return { echoed_form: request.body?.toString('utf8'), echoed_headers: request.headers };
}

/**
 * The fake estate of ACT-53 for `oauth2`: a token endpoint that echoes what
 * it was sent and answers with `grant` (rotating by default), and an API
 * that echoes its request in every encoding a hostile destination might use.
 */
function oauth2Harness(
  grant: Readonly<Record<string, unknown>> = ROTATING,
): ReturnType<typeof harnessOver> {
  return harnessOver((request) =>
    isOAuth2TokenRequest(request)
      ? oauth2Grant({ expires_in: '3600', ...grant, ...echoed(request) })
      : echoResponse(request),
  );
}

function secretVariants(...extra: readonly string[]): readonly string[] {
  return [
    ...scrubVariants(OAUTH2_CANARY.accessToken),
    ...scrubVariants(OAUTH2_CANARY.rotatedRefreshToken),
    ...scrubVariants(CANARY.password, 'alice@example.com'),
    ...scrubVariants(CANARY.password, OAUTH2_CLIENT),
    ...scrubVariants(CANARY.hiddenField),
    ...extra,
  ];
}

describe('the oauth2 adapter through the engine: secret handling', () => {
  it('ACT-53 ACT-128 no variant of the client secret, either refresh token or the access token reaches the result, the row, the audit trail or the log', async () => {
    const { fake, harness } = oauth2Harness();
    await createHttpTarget(harness, { name: 'books', base_url: OAUTH2_BASE_URL, mapping: MAPPING });
    const result = resultOf(
      await harness.engine.call(caller(), httpInvocation({ target: 'books', path: '/invoices' })),
    );
    expect(fake.requests[1]?.headers['authorization']).toBe(
      `Zoho-oauthtoken ${OAUTH2_CANARY.accessToken}`,
    );
    expect(String(result['body'])).toContain(
      `"authorization":"Zoho-oauthtoken [redacted:${OAUTH2_ACCESS_TOKEN_FIELD}]"`,
    );
    const everything = surfaces(harness, [result]);
    expect(secretVariants().filter((variant) => everything.includes(variant))).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'ok', classification: 'GET' }]);
  });

  it('ACT-53 ACT-125 Basic client authentication leaks nothing either, the Basic credentials included', async () => {
    const { fake, harness } = oauth2Harness();
    await createHttpTarget(harness, {
      name: 'books',
      base_url: OAUTH2_BASE_URL,
      mapping: { ...MAPPING, client_auth: 'basic', prefix: 'Bearer ' },
    });
    const result = resultOf(
      await harness.engine.call(caller(), httpInvocation({ target: 'books', path: '/invoices' })),
    );
    const basic = oauth2TokenRequests(fake)[0]?.headers['authorization'] ?? '';
    expect(basic.startsWith('Basic ')).toBe(true);
    const everything = surfaces(harness, [result]);
    const leaked = secretVariants(basic, basic.slice('Basic '.length));
    expect(leaked.filter((variant) => everything.includes(variant))).toStrictEqual([]);
  });

  it('ACT-53 ACT-126 a refusal whose description repeats the request leaves only the code, and no secret, in the error, the row and the trail', async () => {
    const { harness } = harnessOver((request) =>
      isOAuth2TokenRequest(request)
        ? Response.json(
            { error: 'invalid_grant', error_description: `ECHOED-REQUEST ${String(request.body)}` },
            { status: 400 },
          )
        : echoResponse(request),
    );
    await createHttpTarget(harness, { name: 'books', base_url: OAUTH2_BASE_URL, mapping: MAPPING });
    const error = errorOf(
      await harness.engine.call(caller(), httpInvocation({ target: 'books', path: '/invoices' })),
    );
    expect([error.code, error.detail]).toStrictEqual([
      'authentication_failed',
      { error: 'invalid_grant' },
    ]);
    const everything = surfaces(harness, [error, error.message]);
    expect(secretVariants().filter((variant) => everything.includes(variant))).toStrictEqual([]);
    expect(everything).not.toContain('ECHOED-REQUEST');
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'error:authentication_failed',
    ]);
  });

  it('ACT-127 a changed refresh token is written to the vault item and audited by field name only', async () => {
    const { harness } = oauth2Harness();
    const target = await createHttpTarget(harness, {
      name: 'books',
      base_url: OAUTH2_BASE_URL,
      mapping: MAPPING,
    });
    await harness.engine.call(caller(), httpInvocation({ target: 'books', path: '/invoices' }));
    expect(harness.vault.storedSecrets('item-login')?.hiddenFields).toMatchObject({
      'API key': OAUTH2_CANARY.rotatedRefreshToken,
    });
    expect(harness.audit).toContainEqual({
      category: 'actions',
      action: 'credential_rotated',
      outcome: 'ok',
      itemId: target.credential.item_id,
      field: REFRESH_FIELD,
      details: { target: 'books', connector: 'http' },
    });
  });

  it('ACT-127 a token endpoint that echoes the refresh token it was sent causes no vault write and no event', async () => {
    const { harness } = oauth2Harness({ refresh_token: CANARY.hiddenField });
    await createHttpTarget(harness, { name: 'crm', base_url: OAUTH2_BASE_URL, mapping: MAPPING });
    const outcome = await harness.engine.call(
      caller(),
      httpInvocation({ target: 'crm', path: '/x' }),
    );
    expect(resultOf(outcome)).toMatchObject({ status: 200 });
    expect(harness.vault.storedSecrets('item-login')?.hiddenFields).toMatchObject({
      'API key': CANARY.hiddenField,
    });
    expect(harness.audit.filter((event) => event.action === 'credential_rotated')).toStrictEqual(
      [],
    );
  });

  it('ACT-124 ACT-125 ACT-129 the token host is checked at save and resolved only when a token is exchanged, never pinned for the call', async () => {
    const { fake, harness } = oauth2Harness();
    await createHttpTarget(harness, { name: 'books', base_url: OAUTH2_BASE_URL, mapping: MAPPING });
    const invocation = httpInvocation({ target: 'books', path: '/invoices' });
    await harness.engine.call(caller(), invocation);
    await harness.engine.call(caller(), invocation);
    expect(oauth2TokenRequests(fake)).toHaveLength(1);
    // One at save time (ACT-3, ACT-124) and one for the one exchange (ACT-55).
    expect(harness.lookups.filter((host) => host === OAUTH2_TOKEN_HOST)).toHaveLength(2);
    // One at save time and one per call: the destination alone is pinned.
    expect(harness.lookups.filter((host) => host === 'api.example.com')).toHaveLength(3);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual(['ok', 'ok']);
  });
});
