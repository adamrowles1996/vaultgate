import { describe, expect, it } from 'vitest';

import {
  caller,
  CLIENT_ID,
  createActionsHarness,
  createHttpTarget,
  errorOf,
  httpInvocation,
  OPERATOR_ID,
  OTHER_CLIENT_ID,
  resultOf,
  storedCalls,
} from '../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../test-support/actions-pages.ts';
import { unwrapOk } from '../test-support/result.ts';
import {
  createSqlTarget,
  harnessOverSql,
  sqlInvocation,
  sqlWriteInvocation,
  WRITE_POLICY,
} from '../test-support/sql-connector.ts';
import { createSshTarget, harnessOverSsh, sshInvocation } from '../test-support/ssh-connector.ts';
import { VaultError } from '../vault/client.ts';

const sqlCaller = () => caller({ scopes: ['actions:sql.read', 'actions:sql.write'] });

describe('read-only client grants', () => {
  it('ACT-9 ACT-19 allows SQL reads while refusing DML and DDL before credentials and leaving other clients unchanged', async () => {
    const { harness, fake } = harnessOverSql();
    const { targets } = harness.engine;
    const target = await createSqlTarget(harness, {
      policy: { ...WRITE_POLICY, write_classes: ['dml', 'ddl'] },
      grantTo: [OTHER_CLIENT_ID],
    });
    unwrapOk(targets.grant(target.id, CLIENT_ID, OPERATOR_ID, true));
    expect(harness.engine.listTargets(sqlCaller())[0]?.operations).toStrictEqual(['read']);
    expect(
      harness.engine.listTargets({ ...sqlCaller(), clientId: OTHER_CLIENT_ID })[0]?.operations,
    ).toStrictEqual(['read', 'write']);
    resultOf(await harness.engine.call(sqlCaller(), sqlInvocation()));
    unwrapOk(targets.grant(target.id, CLIENT_ID, OPERATOR_ID));
    expect(targets.repo.isReadOnly(target.id, CLIENT_ID)).toBe(true);
    const before = fake.requests.length;
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    for (const statement of ['DELETE FROM t', 'CREATE TABLE t (id INT)']) {
      const outcome = await harness.engine.call(sqlCaller(), sqlWriteInvocation({ statement }));
      expect(errorOf(outcome)).toMatchObject({
        code: 'policy_denied',
        detail: { reason: 'grant_read_only' },
      });
    }
    expect(fake.requests).toHaveLength(before);
    expect(
      storedCalls(harness.database)
        .slice(-2)
        .map((row) => row.outcome),
    ).toStrictEqual(['denied:policy_denied', 'denied:policy_denied']);
    harness.vault.failWith(null);
    resultOf(
      await harness.engine.call(
        { ...sqlCaller(), clientId: OTHER_CLIENT_ID },
        sqlWriteInvocation(),
      ),
    );
    unwrapOk(targets.revokeGrant(target.id, CLIENT_ID, OPERATOR_ID));
    expect(harness.engine.listTargets(sqlCaller())).toStrictEqual([]);
    const revoked = await harness.engine.call(sqlCaller(), sqlInvocation());
    expect(errorOf(revoked).code).toBe('not_granted');
    unwrapOk(targets.grant(target.id, CLIENT_ID, OPERATOR_ID));
    expect(targets.repo.isReadOnly(target.id, CLIENT_ID)).toBe(false);
    resultOf(await harness.engine.call(sqlCaller(), sqlWriteInvocation()));
  });

  it('ACT-9 also denies HTTP writes under a broad HTTP scope and never widens the target policy', async () => {
    const harness = createActionsHarness();
    const target = await createHttpTarget(harness, {
      policy: { allowed_methods: ['GET', 'POST'] },
    });
    unwrapOk(harness.engine.targets.grant(target.id, CLIENT_ID, OPERATOR_ID, true));
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    const post = await harness.engine.call(caller(), httpInvocation({ method: 'POST' }));
    expect(errorOf(post)).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'grant_read_only' },
    });
    const deletion = await harness.engine.call(caller(), httpInvocation({ method: 'DELETE' }));
    expect(errorOf(deletion)).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'method' },
    });
    expect(harness.engine.listTargets(caller())[0]?.operations).toStrictEqual(['read']);
    expect(harness.audit).toContainEqual(
      expect.objectContaining({
        action: 'grant_added',
        details: { target: 'api', connector: 'http', readOnly: true },
      }),
    );
  });

  it('ACT-9 ACT-19 hides a shell-only target and denies it before vault, DNS or transport', async () => {
    const { harness, fake } = harnessOverSsh();
    const target = await createSshTarget(harness);
    unwrapOk(harness.engine.targets.grant(target.id, CLIENT_ID, OPERATOR_ID, true));
    const who = caller({ scopes: ['actions:ssh'] });
    const lookups = harness.lookups.length;
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    expect(harness.engine.listTargets(who)).toStrictEqual([]);
    const outcome = await harness.engine.call(who, sshInvocation());
    expect(errorOf(outcome)).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'grant_read_only' },
    });
    expect(harness.lookups).toHaveLength(lookups);
    expect(fake.opened).toStrictEqual([]);
    expect(fake.commands).toStrictEqual([]);
  });

  it('ACT-9 records the console checkbox and displays its persistent ceiling on the connection page', async () => {
    const harness = createPagesHarness();
    harness.clients.push({ clientId: CLIENT_ID, clientName: 'Reader' });
    const target = await createHttpTarget(harness.actions, { grantTo: [] });
    const { browser, csrf } = await signedInOperator(harness);
    const form = await browser.get(`/account/actions/${target.id}`);
    expect(await form.text()).toContain('name="read_only"');
    const response = await browser.submit(`/account/actions/${target.id}/grants`, {
      csrf,
      client_id: CLIENT_ID,
      read_only: 'on',
    });
    expect(response.status).toBe(303);
    expect(harness.actions.engine.targets.repo.isReadOnly(target.id, CLIENT_ID)).toBe(true);
    const saved = await browser.get(`/account/actions/${target.id}`);
    expect(await saved.text()).toContain('Read only');
  });
});
