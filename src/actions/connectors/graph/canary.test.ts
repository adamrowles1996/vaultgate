import { describe, expect, it } from 'vitest';

import {
  caller,
  createHttpTarget,
  httpInvocation,
  resultOf,
  storedCalls,
} from '../../../test-support/actions-fixtures.ts';
import {
  GRAPH_BASE_URL,
  GRAPH_CANARY,
  GRAPH_CLIENT,
  GRAPH_TENANT,
  isTokenRequest,
  tokenRequests,
  tokenResponse,
} from '../../../test-support/graph.ts';
import { echoResponse, harnessOver, surfaces } from '../../../test-support/http-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { scrubVariants } from '../../scrub.ts';

import { ACCESS_TOKEN_FIELD } from './adapter.ts';

const REFRESH_FIELD = 'custom.API key';

const MAPPING = {
  mode: 'graph',
  tenant_id: GRAPH_TENANT,
  client_id: GRAPH_CLIENT,
  grant: 'refresh_token',
  secret_field: 'password',
  refresh_token_field: REFRESH_FIELD,
};

/**
 * The fake estate of ACT-53 for the adapter: a token endpoint that echoes the
 * form it was posted (client secret and refresh token included) and rotates
 * the refresh token, and a Graph that echoes its request in every encoding a
 * hostile destination might use.
 */
function graphHarness(): ReturnType<typeof harnessOver> {
  return harnessOver((request) =>
    isTokenRequest(request)
      ? tokenResponse({
          refreshToken: GRAPH_CANARY.rotatedRefreshToken,
          echo: request.body?.toString('utf8'),
        })
      : echoResponse(request),
  );
}

describe('the graph adapter through the engine: secret handling', () => {
  it('ACT-75 ACT-53 ACT-51 no variant of the client secret, the refresh token or the access token reaches the result, the row, the audit trail or the log', async () => {
    const { fake, harness } = graphHarness();
    await createHttpTarget(harness, {
      name: 'graph',
      base_url: GRAPH_BASE_URL,
      mapping: MAPPING,
    });
    const result = resultOf(
      await harness.engine.call(caller(), httpInvocation({ target: 'graph', path: '/users' })),
    );
    expect(fake.requests[1]?.headers['authorization']).toBe(`Bearer ${GRAPH_CANARY.accessToken}`);
    expect(String(result['body'])).toContain(
      `"authorization":"Bearer [redacted:${ACCESS_TOKEN_FIELD}]"`,
    );
    const everything = surfaces(harness, [result]);
    const variants = [
      ...scrubVariants(GRAPH_CANARY.accessToken),
      ...scrubVariants(GRAPH_CANARY.rotatedRefreshToken),
      ...scrubVariants(CANARY.password, 'alice@example.com'),
      ...scrubVariants(CANARY.hiddenField),
    ];
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'ok', classification: 'GET' }]);
  });

  it('ACT-83 the rotated refresh token is written to the vault item and audited by field name only', async () => {
    const { harness } = graphHarness();
    const target = await createHttpTarget(harness, {
      name: 'graph',
      base_url: GRAPH_BASE_URL,
      mapping: MAPPING,
    });
    await harness.engine.call(caller(), httpInvocation({ target: 'graph', path: '/users' }));
    expect(harness.vault.storedSecrets('item-login')?.hiddenFields).toMatchObject({
      'API key': GRAPH_CANARY.rotatedRefreshToken,
    });
    expect(harness.audit).toContainEqual({
      category: 'actions',
      action: 'credential_rotated',
      outcome: 'ok',
      itemId: target.credential.item_id,
      field: REFRESH_FIELD,
      details: { target: 'graph', connector: 'http' },
    });
  });

  it('ACT-50 ACT-82 ACT-55 the token is obtained once, and the endpoint is resolved only when it is', async () => {
    const { fake, harness } = graphHarness();
    await createHttpTarget(harness, {
      name: 'graph',
      base_url: GRAPH_BASE_URL,
      mapping: MAPPING,
    });
    const invocation = httpInvocation({ target: 'graph', path: '/users' });
    await harness.engine.call(caller(), invocation);
    await harness.engine.call(caller(), invocation);
    expect(tokenRequests(fake)).toHaveLength(1);
    expect(harness.lookups.filter((host) => host === 'login.microsoftonline.com')).toHaveLength(1);
    // One at save time (ACT-3) and one per call (ACT-55).
    expect(harness.lookups.filter((host) => host === 'graph.microsoft.com')).toHaveLength(3);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual(['ok', 'ok']);
  });
});
