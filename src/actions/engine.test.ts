import { describe, expect, it } from 'vitest';

import { run } from '../storage/query.ts';
import { ACTIONS_OFF, actionsEnabled } from '../test-support/actions-config.ts';
import {
  type ActionsHarness,
  caller,
  CLIENT_ID,
  createActionsHarness,
  createHttpTarget,
  errorOf,
  httpInvocation,
  OPERATOR_ID,
  resultOf,
  storedCalls,
} from '../test-support/actions-fixtures.ts';
import { createEchoConnector } from '../test-support/fake-connector.ts';
import { VaultError } from '../vault/client.ts';

import type { Caller } from './caller.ts';
import type { ActionErrorCode } from './errors.ts';

interface Refusal {
  readonly code: ActionErrorCode;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/**
The last call as the trail recorded it: the refusal, the row outcome and the audit event outcome.
*/
async function refused(
  harness: ActionsHarness,
  who: Caller,
  toolArguments: Readonly<Record<string, unknown>> = {},
): Promise<Refusal & { readonly row: string; readonly audit: string }> {
  const error = errorOf(await harness.engine.call(who, httpInvocation(toolArguments)));
  const row = storedCalls(harness.database).at(-1);
  const event = harness.audit.at(-1);
  return {
    code: error.code,
    ...(error.detail !== undefined && { detail: error.detail }),
    row: row?.outcome ?? 'no row',
    audit: `${event?.outcome ?? 'no event'}/${String(event?.details?.['outcome'])}`,
  };
}

describe('call resolution order', () => {
  it('ACT-16 stops at the first failure in the order of 13.6.1, each with its own code and audit outcome', async () => {
    const off = createActionsHarness({ config: ACTIONS_OFF });
    await createHttpTarget(off);
    expect(await refused(off, caller())).toStrictEqual({
      code: 'actions_disabled',
      row: 'denied:actions_disabled',
      audit: 'denied/denied:actions_disabled',
    });
    const harness = createActionsHarness();
    expect(await refused(harness, caller())).toMatchObject({ code: 'unknown_target' });
    const target = await createHttpTarget(harness, { grantTo: [] });
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    expect(await refused(harness, caller())).toStrictEqual({
      code: 'not_granted',
      row: 'denied:not_granted',
      audit: 'denied/denied:not_granted',
    });
    harness.vault.failWith(null);
    harness.engine.targets.grant(target.id, CLIENT_ID, OPERATOR_ID);
    harness.engine.targets.setEnabled(target.id, false, OPERATOR_ID);
    expect(await refused(harness, caller())).toMatchObject({ code: 'target_disabled' });
    harness.engine.targets.setEnabled(target.id, true, OPERATOR_ID);
    run(harness.database, 'UPDATE action_targets SET policy = ? WHERE id = ?', '[]', target.id);
    expect(await refused(harness, caller())).toMatchObject({ code: 'target_invalid' });
    run(
      harness.database,
      'UPDATE action_targets SET policy = ? WHERE id = ?',
      '{"allowed_paths":["/v1/*"]}',
      target.id,
    );
    expect(await refused(harness, caller({ scopes: ['vault:read'] }))).toStrictEqual({
      code: 'insufficient_scope',
      detail: { scope: 'actions:http' },
      row: 'denied:insufficient_scope',
      audit: 'denied/denied:insufficient_scope',
    });
    expect(await refused(harness, caller(), { method: 'BREW' })).toMatchObject({
      code: 'invalid_arguments',
      detail: { problems: expect.stringContaining('method') as string },
    });
    expect(await refused(harness, caller(), { extra: 1 })).toMatchObject({
      code: 'invalid_arguments',
      detail: { problems: expect.stringContaining('(root)') as string },
    });
    expect(await refused(harness, caller(), { path: '/v2/x' })).toStrictEqual({
      code: 'policy_denied',
      detail: { reason: 'path' },
      row: 'denied:policy_denied',
      audit: 'denied/denied:policy_denied',
    });
    const allowed = await harness.engine.call(caller(), httpInvocation());
    expect(resultOf(allowed)['status']).toBe(200);
    expect(harness.lookups).toStrictEqual(['api.example.com', 'api.example.com']);
  });

  it('ACT-16 ACT-67 answers connector_disabled after the grant check when the connector is switched off or its runtime is not loaded', async () => {
    const off = createActionsHarness({ config: actionsEnabled([]) });
    await createHttpTarget(off);
    expect(await refused(off, caller())).toMatchObject({
      code: 'connector_disabled',
      row: 'denied:connector_disabled',
    });
    const unloaded = createActionsHarness({ loadRuntime: false });
    await createHttpTarget(unloaded);
    expect(await refused(unloaded, caller())).toMatchObject({ code: 'connector_disabled' });
    await createHttpTarget(unloaded, { name: 'other', grantTo: [] });
    const other = await unloaded.engine.call(caller(), httpInvocation({ target: 'other' }));
    expect(errorOf(other).code).toBe('not_granted');
  });

  it('ACT-16 refuses a tool that does not belong to the connector as invalid arguments', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness);
    const outcome = await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), {
      tool: 'sql_query',
      target: 'api',
      arguments: { target: 'api', statement: 'SELECT 1' },
    });
    expect(errorOf(outcome)).toMatchObject({
      code: 'invalid_arguments',
      detail: { problem: 'the tool does not apply to this target' },
    });
  });

  it('ACT-39 ACT-40 returns the policy reason to the agent and classifies GET, HEAD and OPTIONS as read and every other method as write', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness, {
      policy: { allowed_methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE'] },
    });
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE']) {
      resultOf(await harness.engine.call(caller(), httpInvocation({ method })));
    }
    expect(storedCalls(harness.database).map((call) => call.operation)).toStrictEqual([
      'read',
      'read',
      'read',
      'write',
      'write',
    ]);
    expect(await refused(harness, caller(), { method: 'PUT' })).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'method' },
    });
    expect(await refused(harness, caller(), { headers: { Cookie: 'x' } })).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'header' },
    });
    expect(JSON.stringify(harness.audit)).not.toContain('/**');
  });

  it('ACT-59 applies the per-target limit of the policy before confirmation, auditing denied:rate_limited with retry_after_s', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness, {
      policy: { rate_limit_per_minute: 2, allowed_methods: ['GET', 'POST'], confirm_writes: true },
    });
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(await refused(harness, caller(), { method: 'POST' })).toStrictEqual({
      code: 'rate_limited',
      detail: { retry_after_s: 30 },
      row: 'denied:rate_limited',
      audit: 'denied/denied:rate_limited',
    });
    await harness.clock.advance(30_000);
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'not_required',
      'not_required',
      'not_required',
      'not_required',
    ]);
  });

  it('ACT-59 caps the calls in flight per target and releases the slots when the calls end', async () => {
    const harness = createActionsHarness({ connector: createEchoConnector({ mode: 'hang' }) });
    await createHttpTarget(harness, { policy: { timeout_ms: 5000 } });
    const hanging = Array.from({ length: 4 }, () =>
      harness.engine.call(caller(), httpInvocation()),
    );
    expect(await refused(harness, caller())).toMatchObject({
      code: 'rate_limited',
      detail: { retry_after_s: 1 },
      row: 'denied:rate_limited',
    });
    await harness.clock.advance(5000);
    const timedOut = await Promise.all(hanging);
    expect(timedOut.map((outcome) => errorOf(outcome).code)).toStrictEqual([
      'timeout',
      'timeout',
      'timeout',
      'timeout',
    ]);
    const admitted = harness.engine.call(caller(), httpInvocation());
    await harness.clock.advance(5000);
    expect(errorOf(await admitted).code).toBe('timeout');
  });
});

describe('listTargets', () => {
  it('ACT-19 lists only granted, enabled, valid targets of loaded connectors that the scopes can reach, without destination, credential or pattern', async () => {
    const harness = createActionsHarness({
      connector: createEchoConnector({ advertise: { engine: 'postgres', unrestricted: true } }),
    });
    await createHttpTarget(harness, {
      description: 'The example API',
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
    });
    await createHttpTarget(harness, { name: 'ungranted', grantTo: [] });
    const disabled = await createHttpTarget(harness, { name: 'disabled' });
    harness.engine.targets.setEnabled(disabled.id, false, OPERATOR_ID);
    const invalid = await createHttpTarget(harness, { name: 'invalid' });
    run(harness.database, 'UPDATE action_targets SET policy = ? WHERE id = ?', '[]', invalid.id);
    expect(harness.engine.listTargets(caller())).toStrictEqual([
      {
        name: 'api',
        description: 'The example API',
        connector: 'http',
        operations: ['read', 'write'],
        confirm_writes: true,
        engine: 'postgres',
        unrestricted: true,
      },
    ]);
    expect(harness.engine.listTargets(caller({ scopes: ['vault:read'] }))).toStrictEqual([]);
    expect(harness.engine.listTargets(caller({ clientId: 'vg_c_other' }))).toStrictEqual([]);
  });

  it('ACT-19 ACT-14 lists nothing while the layer is off, the connector is off or its runtime is not loaded', async () => {
    const off = createActionsHarness({ config: ACTIONS_OFF });
    await createHttpTarget(off);
    expect(off.engine.listTargets(caller())).toStrictEqual([]);
    const connectorOff = createActionsHarness({ config: actionsEnabled([]) });
    await createHttpTarget(connectorOff);
    expect(connectorOff.engine.listTargets(caller())).toStrictEqual([]);
    const unloaded = createActionsHarness({ loadRuntime: false });
    await createHttpTarget(unloaded);
    expect(unloaded.engine.listTargets(caller())).toStrictEqual([]);
  });

  it('ACT-73 reports the connectors whose runtime is loaded', () => {
    expect(createActionsHarness().engine.connectors).toStrictEqual(['http']);
    expect(createActionsHarness({ loadRuntime: false }).engine.connectors).toStrictEqual([]);
  });
});
