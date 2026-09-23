import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID,
  createActionsHarness,
  createHttpTarget,
  OPERATOR_ID,
  OTHER_CLIENT_ID,
} from '../test-support/actions-fixtures.ts';
import { grantRows, openSession, sessionRows } from '../test-support/actions-store-fixtures.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

describe('grants', () => {
  it('ACT-9 grants are per registered client; revoking leaves a record and closes the client sessions, re-granting revives it', async () => {
    const harness = createActionsHarness();
    const { targets } = harness.engine;
    const created = await createHttpTarget(harness, { grantTo: [] });
    expect(targets.repo.isGranted(created.id, CLIENT_ID)).toBe(false);
    unwrapOk(targets.grant(created.id, CLIENT_ID, OPERATOR_ID));
    unwrapOk(targets.grant(created.id, OTHER_CLIENT_ID, OPERATOR_ID));
    const stranger = targets.grant(created.id, 'vg_c_stranger', OPERATOR_ID);
    expect(unwrapFail(stranger).problems).toStrictEqual(['client_id: no such client']);
    const missing = targets.grant('nope', CLIENT_ID, OPERATOR_ID);
    expect(unwrapFail(missing).problems).toStrictEqual(['id: no such target']);
    expect(targets.repo.isGranted(created.id, CLIENT_ID)).toBe(true);
    openSession(harness.database, 'session-1', created.id, CLIENT_ID);
    harness.audit.length = 0;
    await harness.clock.advance(5);
    const revoked = unwrapOk(targets.revokeGrant(created.id, CLIENT_ID, OPERATOR_ID));
    expect(revoked.grants).toStrictEqual([
      {
        targetId: created.id,
        clientId: CLIENT_ID,
        grantedAt: harness.clock.now() - 5,
        grantedBy: OPERATOR_ID,
        revokedAt: harness.clock.now(),
      },
      {
        targetId: created.id,
        clientId: OTHER_CLIENT_ID,
        grantedAt: harness.clock.now() - 5,
        grantedBy: OPERATOR_ID,
        revokedAt: undefined,
      },
    ]);
    expect(targets.repo.isGranted(created.id, CLIENT_ID)).toBe(false);
    expect(targets.repo.listGranted(CLIENT_ID)).toStrictEqual([]);
    expect(targets.repo.listGranted(OTHER_CLIENT_ID).map((row) => row.name)).toStrictEqual(['api']);
    expect(sessionRows(harness.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'revoked' },
    ]);
    expect(harness.audit).toStrictEqual([
      {
        category: 'actions',
        action: 'grant_removed',
        outcome: 'ok',
        operatorId: OPERATOR_ID,
        clientId: CLIENT_ID,
        details: { target: 'api', connector: 'http', sessions: 1 },
      },
    ]);
    unwrapOk(targets.grant(created.id, CLIENT_ID, OPERATOR_ID));
    expect(grantRows(harness.database, created.id)).toStrictEqual([
      { client_id: CLIENT_ID, revoked_at: null },
      { client_id: OTHER_CLIENT_ID, revoked_at: null },
    ]);
    const unknown = targets.revokeGrant('nope', CLIENT_ID, OPERATOR_ID);
    expect(unwrapFail(unknown).problems).toStrictEqual(['id: no such target']);
  });

  it('ACT-10 revoking a consent revokes every grant of the client and closes its sessions, leaving other clients alone', async () => {
    const harness = createActionsHarness();
    const { targets } = harness.engine;
    const first = await createHttpTarget(harness, {
      name: 'first',
      grantTo: [CLIENT_ID, OTHER_CLIENT_ID],
    });
    const second = await createHttpTarget(harness, { name: 'second', grantTo: [CLIENT_ID] });
    openSession(harness.database, 'session-1', first.id, CLIENT_ID);
    openSession(harness.database, 'session-2', second.id, CLIENT_ID);
    openSession(harness.database, 'session-3', first.id, OTHER_CLIENT_ID);
    expect(targets.onConsentRevoked(CLIENT_ID)).toStrictEqual({ grants: 2, sessions: 2 });
    expect(targets.repo.listGranted(CLIENT_ID)).toStrictEqual([]);
    expect(targets.repo.isGranted(first.id, OTHER_CLIENT_ID)).toBe(true);
    expect(sessionRows(harness.database)).toStrictEqual([
      { id_hash: 'session-1', close_reason: 'revoked' },
      { id_hash: 'session-2', close_reason: 'revoked' },
      { id_hash: 'session-3', close_reason: null },
    ]);
    expect(targets.onConsentRevoked(CLIENT_ID)).toStrictEqual({ grants: 0, sessions: 0 });
  });
});
