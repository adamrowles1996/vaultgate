import { describe, expect, it } from 'vitest';

import {
  caller,
  CLIENT_ID,
  createHttpTarget,
  errorOf,
  httpInvocation,
  OPERATOR_ID,
  storedCalls,
} from '../../../test-support/actions-fixtures.ts';
import { fixtureTargetRow } from '../../../test-support/actions-store-fixtures.ts';
import { coded, harnessOver, textResponse as text } from '../../../test-support/http-connector.ts';

const GRAPH = {
  mode: 'graph',
  tenant_id: 'contoso.onmicrosoft.com',
  client_id: '11111111-2222-3333-4444-555555555555',
  grant: 'client_credentials',
  secret_field: 'password',
};

describe('the http connector through the engine: refusals and failures', () => {
  it('ACT-39 ACT-16 ACT-20 audits every http policy reason as denied:policy_denied with the reason, and a malformed path as invalid_arguments, without sending anything', async () => {
    const { fake, harness } = harnessOver(() => text(200, 'never'));
    await createHttpTarget(harness);
    const attempts = [
      httpInvocation({ method: 'POST' }),
      httpInvocation({ path: '/%2e%2e/x' }),
      httpInvocation({ headers: { 'X-Trace': '1' } }),
      httpInvocation({ body: 'x'.repeat(256 * 1024 + 1) }),
      httpInvocation({ path: '/v1/../x' }),
      httpInvocation({ path: '//evil.example/x' }),
    ];
    const who = caller();
    const errors = [];
    for (const attempt of attempts) {
      const outcome = await harness.engine.call(who, attempt);
      errors.push(errorOf(outcome));
    }
    expect(errors.map((error) => [error.code, error.detail?.['reason']])).toStrictEqual([
      ['policy_denied', 'method'],
      ['policy_denied', 'path'],
      ['policy_denied', 'header'],
      ['policy_denied', 'body_size'],
      ['invalid_arguments', undefined],
      ['invalid_arguments', undefined],
    ]);
    expect(String(errors[4]?.detail?.['problems'])).toContain('must not contain a .. segment');
    expect(String(errors[5]?.detail?.['problems'])).toContain('must not contain an empty segment');
    expect(fake.requests).toStrictEqual([]);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'denied:policy_denied',
      'denied:policy_denied',
      'denied:policy_denied',
      'denied:policy_denied',
      'denied:invalid_arguments',
      'denied:invalid_arguments',
    ]);
  });

  it('ACT-57 ACT-74 a TLS failure and a refused connection are error outcomes whose detail names the code, never the address', async () => {
    const { harness } = harnessOver((_request, index) =>
      coded(`connect to 93.184.216.34:443 failed`, ['CERT_HAS_EXPIRED', 'ECONNRESET'][index] ?? ''),
    );
    await createHttpTarget(harness);
    const tls = errorOf(await harness.engine.call(caller(), httpInvocation()));
    const reset = errorOf(await harness.engine.call(caller(), httpInvocation()));
    expect([tls, reset].map((error) => [error.code, error.detail])).toStrictEqual([
      ['tls_error', { reason: 'CERT_HAS_EXPIRED' }],
      ['connection_failed', { reason: 'ECONNRESET' }],
    ]);
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'error:tls_error',
      'error:connection_failed',
    ]);
    expect(JSON.stringify([tls.detail, reset.detail])).not.toContain('93.184');
  });

  it('ACT-1 ACT-81 a stored target the connector refuses to save (a graph mapping off graph.microsoft.com, query without consent) is invalid on read and refuses every call with target_invalid', async () => {
    const { fake, harness } = harnessOver(() => text(200, 'never'));
    const { repo } = harness.engine.targets;
    repo.insert(
      fixtureTargetRow({
        id: 'graph-row',
        name: 'graph',
        destination: { base_url: 'https://api.example.com/v1' },
        credential: { item_id: 'item-login', mapping: GRAPH },
      }),
    );
    repo.insert(
      fixtureTargetRow({
        id: 'query-row',
        name: 'queried',
        credential: {
          item_id: 'item-login',
          mapping: { mode: 'query', field: 'password', name: 'k' },
        },
      }),
    );
    repo.grant('graph-row', CLIENT_ID, 0, OPERATOR_ID);
    repo.grant('query-row', CLIENT_ID, 0, OPERATOR_ID);
    const graph = errorOf(await harness.engine.call(caller(), httpInvocation({ target: 'graph' })));
    const queried = errorOf(
      await harness.engine.call(caller(), httpInvocation({ target: 'queried' })),
    );
    expect([graph.code, queried.code]).toStrictEqual(['target_invalid', 'target_invalid']);
    expect(harness.engine.targets.get('graph-row')).toMatchObject({
      state: 'invalid',
      problems: [
        'credential.mapping: the graph mode requires base_url on https://graph.microsoft.com',
      ],
    });
    expect(harness.engine.targets.get('query-row')).toMatchObject({
      state: 'invalid',
      problems: ['credential.mapping: the query mode requires policy.allow_query_credentials'],
    });
    expect(harness.engine.listTargets(caller())).toStrictEqual([]);
    expect(fake.requests).toStrictEqual([]);
  });
});
