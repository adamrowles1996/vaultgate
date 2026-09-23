import { describe, expect, it } from 'vitest';

import { run } from '../storage/query.ts';
import {
  CLIENT_ID,
  createActionsHarness,
  createHttpTarget,
  OPERATOR_ID,
  OTHER_CLIENT_ID,
  storedCalls,
} from '../test-support/actions-fixtures.ts';
import {
  grantRows,
  openSession,
  problemPaths,
  sessionRows,
} from '../test-support/actions-store-fixtures.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { INTERRUPTED_OUTCOME, recordCall } from './calls.ts';

const EDIT = {
  description: 'Renamed',
  destination: { base_url: 'https://api.example.com/v2' },
  internal: false,
  credential: {
    item_id: 'item-login',
    mapping: { mode: 'header', field: 'custom.API key', name: 'X-Api-Key' },
  },
  policy: { allowed_paths: ['/**'], confirm_writes: true },
};

describe('target lifecycle', () => {
  it('ACT-1 ACT-7 creates a target from validated documents at revision 1, audits it and reports it valid with its grants', async () => {
    const harness = createActionsHarness();
    const at = harness.clock.now();
    const created = await createHttpTarget(harness, { description: 'Example API' });
    expect(created).toStrictEqual({
      id: 'id-1',
      name: 'api',
      description: 'Example API',
      connector: 'http',
      destination: { base_url: 'https://api.example.com/v1' },
      internal: false,
      credential: { item_id: 'item-login', mapping: { mode: 'bearer', field: 'password' } },
      policy: { allowed_paths: ['/**'] },
      enabled: true,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: OPERATOR_ID,
      state: 'valid',
      problems: [],
      destinationSummary: 'api.example.com/v1',
      grants: [
        {
          targetId: 'id-1',
          clientId: CLIENT_ID,
          grantedAt: at,
          grantedBy: OPERATOR_ID,
          revokedAt: undefined,
        },
      ],
    });
    expect(harness.engine.targets.list().map((target) => target.name)).toStrictEqual(['api']);
    expect(harness.engine.targets.get('id-1')?.name).toBe('api');
    expect(harness.engine.targets.get('nope')).toBeUndefined();
    expect(harness.audit).toStrictEqual([
      {
        category: 'actions',
        action: 'target_created',
        outcome: 'ok',
        operatorId: OPERATOR_ID,
        clientId: undefined,
        details: { target: 'api', connector: 'http' },
      },
      {
        category: 'actions',
        action: 'grant_added',
        outcome: 'ok',
        operatorId: OPERATOR_ID,
        clientId: CLIENT_ID,
        details: { target: 'api', connector: 'http' },
      },
    ]);
  });

  it('ACT-1 ACT-7 update validates like create, bumps the revision, closes sessions and audits the changed field names only', async () => {
    const harness = createActionsHarness();
    const created = await createHttpTarget(harness);
    openSession(harness.database, 'session-1', created.id, CLIENT_ID);
    harness.audit.length = 0;
    await harness.clock.advance(1000);
    const updated = unwrapOk(await harness.engine.targets.update(created.id, EDIT, OPERATOR_ID));
    expect(updated).toMatchObject({
      revision: 2,
      description: 'Renamed',
      updatedAt: harness.clock.now(),
      updatedBy: OPERATOR_ID,
      destinationSummary: 'api.example.com/v2',
      state: 'valid',
    });
    expect(harness.engine.targets.get(created.id)).toStrictEqual(updated);
    expect(harness.audit).toStrictEqual([
      {
        category: 'actions',
        action: 'target_updated',
        outcome: 'ok',
        operatorId: OPERATOR_ID,
        clientId: undefined,
        details: {
          target: 'api',
          connector: 'http',
          changed: ['description', 'destination', 'credential', 'policy'],
          sessions: 1,
        },
      },
    ]);
    expect(JSON.stringify(harness.audit)).not.toContain('X-Api-Key');
    expect(sessionRows(harness.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'target_changed' },
    ]);
    const unchanged = await harness.engine.targets.update(created.id, EDIT, OPERATOR_ID);
    expect(unwrapOk(unchanged).revision).toBe(2);
    expect(harness.audit).toHaveLength(1);
    const missing = await harness.engine.targets.update('nope', EDIT, OPERATOR_ID);
    expect(unwrapFail(missing).problems).toStrictEqual(['id: no such target']);
    const partial = await harness.engine.targets.update(
      created.id,
      { description: 'x' },
      OPERATOR_ID,
    );
    expect(problemPaths(unwrapFail(partial).problems)).toStrictEqual([
      'destination',
      'credential',
      'policy',
    ]);
  });

  it('ACT-1 stores a target created disabled and an edit that turns internal on', async () => {
    const harness = createActionsHarness({ addresses: { 'intranet.local': ['10.0.0.9'] } });
    const created = await createHttpTarget(harness, { enabled: false });
    expect(created).toMatchObject({ enabled: false, revision: 1 });
    const updated = await harness.engine.targets.update(
      created.id,
      { ...EDIT, destination: { base_url: 'http://intranet.local' }, internal: true },
      OPERATOR_ID,
    );
    expect(unwrapOk(updated)).toMatchObject({ internal: true, revision: 2, enabled: false });
    expect(harness.engine.targets.get(created.id)?.internal).toBe(true);
  });

  it('ACT-1 reports a stored row that no longer validates as invalid, with the reasons', async () => {
    const harness = createActionsHarness();
    const created = await createHttpTarget(harness);
    run(
      harness.database,
      'UPDATE action_targets SET policy = ? WHERE id = ?',
      '{"allowed_paths":5}',
      created.id,
    );
    const summary = harness.engine.targets.get(created.id);
    expect(summary).toMatchObject({ state: 'invalid', destinationSummary: undefined });
    expect(problemPaths(summary?.problems ?? [])).toStrictEqual(['policy.allowed_paths']);
  });

  it('ACT-7 enabling and disabling bump the revision and audit; disabling closes sessions', async () => {
    const harness = createActionsHarness();
    const created = await createHttpTarget(harness);
    openSession(harness.database, 'session-1', created.id, CLIENT_ID);
    harness.audit.length = 0;
    const disabled = harness.engine.targets.setEnabled(created.id, false, OPERATOR_ID);
    expect(unwrapOk(disabled)).toMatchObject({ enabled: false, revision: 2 });
    const enabled = harness.engine.targets.setEnabled(created.id, true, OPERATOR_ID);
    expect(unwrapOk(enabled)).toMatchObject({ enabled: true, revision: 3 });
    expect(harness.engine.targets.get(created.id)?.revision).toBe(3);
    expect(harness.audit.map((event) => [event.action, event.details])).toStrictEqual([
      ['target_disabled', { target: 'api', connector: 'http', sessions: 1 }],
      ['target_enabled', { target: 'api', connector: 'http', sessions: 0 }],
    ]);
    expect(sessionRows(harness.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'target_changed' },
    ]);
    const missing = harness.engine.targets.setEnabled('nope', true, OPERATOR_ID);
    expect(unwrapFail(missing).problems).toStrictEqual(['id: no such target']);
  });

  it('ACT-8 deleting a target cascades its grants, closes its sessions and keeps its calls', async () => {
    const harness = createActionsHarness();
    const created = await createHttpTarget(harness, { grantTo: [CLIENT_ID, OTHER_CLIENT_ID] });
    openSession(harness.database, 'session-1', created.id, CLIENT_ID);
    unwrapOk(
      recordCall(harness.database, {
        id: 'call-1',
        at: 1,
        targetId: created.id,
        targetName: 'api',
        connector: 'http',
        revision: 1,
        tool: 'http_request',
        sessionIdHash: undefined,
        clientId: CLIENT_ID,
        tokenPrefix: 'prefix',
        operation: 'read',
        classification: 'GET',
        arguments: {},
        outputBytes: 0,
        outputTruncated: false,
        durationMs: 0,
        outcome: INTERRUPTED_OUTCOME,
        elicitation: 'not_required',
        confirmationNonce: undefined,
        requestId: undefined,
        ip: undefined,
      }),
    );
    harness.audit.length = 0;
    unwrapOk(harness.engine.targets.remove(created.id, OPERATOR_ID));
    expect(harness.engine.targets.get(created.id)).toBeUndefined();
    expect(grantRows(harness.database, created.id)).toStrictEqual([]);
    expect(sessionRows(harness.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'target_changed' },
    ]);
    expect(storedCalls(harness.database).map((call) => call.targetName)).toStrictEqual(['api']);
    expect(harness.audit).toStrictEqual([
      {
        category: 'actions',
        action: 'target_deleted',
        outcome: 'ok',
        operatorId: OPERATOR_ID,
        clientId: undefined,
        details: { target: 'api', connector: 'http', sessions: 1 },
      },
    ]);
    const missing = harness.engine.targets.remove(created.id, OPERATOR_ID);
    expect(unwrapFail(missing).problems).toStrictEqual(['id: no such target']);
  });
});
