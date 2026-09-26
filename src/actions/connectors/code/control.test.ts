import { describe, expect, it } from 'vitest';

import { run } from '../../../storage/query.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';
import { VaultError } from '../../../vault/client.ts';

describe('the target page status (ACT-115)', () => {
  it('ACT-115 shows each snapshot with its commit, ref, trigger and whether calls answer from it, newest first', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    const target = await createCodeTarget(code);
    await code.harness.clock.advance(1000);
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    const status = await code.harness.engine.code?.status(target.id);
    expect(status?.reachable).toBe(true);
    expect(status?.building).toBe(false);
    expect(
      status?.snapshots.map((snapshot) => [
        snapshot.commit,
        snapshot.ref,
        snapshot.trigger,
        snapshot.current,
      ]),
    ).toStrictEqual([
      [SHA.tag, 'v1.0', 'call', false],
      [SHA.main, 'main', 'save', true],
    ]);
    expect(status?.snapshots[0]).toMatchObject({
      files: 3,
      skipped: { links: 1, special: 0, excluded: 2, large: 0 },
      variants: { 'code+docs+config': { files: 3, chunks: 7 } },
    });
    expect(status?.resolution).toStrictEqual({
      at: 1_790_078_400_000,
      commit: SHA.main,
      ref: 'main',
    });
    expect(status?.lastBuild).toMatchObject({ commit: SHA.tag, trigger: 'call', durationMs: 0 });
    expect(status?.lastFailure).toBeUndefined();
  });

  it('ACT-115 shows a build in progress, and knows no ref or trigger for a snapshot another process built', async () => {
    const code = createCodeHarness();
    const release = code.sidecar.hold();
    const target = await createCodeTarget(code);
    const during = await code.harness.engine.code?.status(target.id);
    expect(during?.building).toBe(true);
    release();
    await code.settle();
    const key = `${target.id}.0123456789abcdef.${SHA.other}`;
    code.sidecar.snapshots.set(key, {
      key,
      owner: target.id,
      commit: SHA.other,
      createdAt: 1,
      variants: ['code'],
    });
    const status = await code.harness.engine.code?.status(target.id);
    expect([
      status?.building,
      status?.snapshots.at(-1)?.ref,
      status?.snapshots.at(-1)?.trigger,
    ]).toStrictEqual([false, undefined, undefined]);
  });

  it('ACT-115 a sidecar that does not answer within 10 seconds shows as unreachable, with what vaultgate remembers', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    code.sidecar.script('list', 'hang');
    const pending = code.harness.engine.code?.status(target.id);
    await code.harness.clock.advance(10_000);
    const status = await pending;
    expect([status?.reachable, status?.snapshots, status?.lastBuild?.commit]).toStrictEqual([
      false,
      [],
      SHA.main,
    ]);
  });

  it('ACT-115 a target this process knows nothing of has no resolution and no builds', async () => {
    const code = createCodeHarness();
    await code.settle();
    expect(await code.harness.engine.code?.status('id-404')).toStrictEqual({
      reachable: true,
      snapshots: [],
      building: false,
      resolution: undefined,
      lastBuild: undefined,
      lastFailure: undefined,
    });
  });
});

describe('Rebuild index and builds that cannot start (ACT-108, ACT-115)', () => {
  it('ACT-108 Rebuild deletes every snapshot of the target and builds the configured ref again, trigger operator', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    await code.harness.engine.code?.refresh(target.id, 'operator', true);
    await code.settle();
    const deletes = code.sidecar.requests.filter((request) => request.method === 'DELETE');
    expect(deletes.map((request) => request.path)).toStrictEqual([`/v1/owners/${target.id}`]);
    const built = code.harness.audit.filter((event) => event.action === 'code_index_built');
    expect(built.map((event) => event.details?.['trigger'])).toStrictEqual(['save', 'operator']);
    expect(code.sidecar.snapshots.size).toBe(1);
  });

  it('ACT-54 ACT-115 a build whose credential cannot be fetched is recorded with credential_unavailable and nothing is fetched', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    code.harness.vault.failWith(new VaultError('vault_unavailable', 'the vault is locked'));
    const requests = code.github.requests.length;
    await code.harness.engine.code?.refresh(target.id, 'operator', false);
    const status = await code.harness.engine.code?.status(target.id);
    expect(status?.lastFailure).toStrictEqual({
      at: code.harness.clock.now(),
      trigger: 'operator',
      durationMs: 0,
      reason: 'credential_unavailable',
    });
    expect(code.github.requests).toHaveLength(requests);
    const failed = code.harness.audit.filter((event) => event.action === 'code_index_failed');
    expect(failed.at(-1)?.details).toStrictEqual({
      target: 'widgets',
      connector: 'code',
      trigger: 'operator',
      content: ['code+docs+config'],
      reason: 'credential_unavailable',
    });
  });

  it('ACT-1 a stored target that no longer validates is recorded as target_invalid, with no content', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    run(
      code.harness.database,
      'UPDATE action_targets SET policy = \'{"max_top_k":9999}\' WHERE id = ?',
      target.id,
    );
    await code.harness.engine.code?.refresh(target.id, 'operator', false);
    const failed = code.harness.audit.filter((event) => event.action === 'code_index_failed');
    expect(failed.at(-1)?.details).toMatchObject({ reason: 'target_invalid', content: [] });
  });

  it('ACT-108 Rebuild of a target that does not exist does nothing', async () => {
    const code = createCodeHarness();
    await code.settle();
    await code.harness.engine.code?.refresh('id-404', 'operator', false);
    expect(
      code.harness.audit.filter((event) => event.action.startsWith('code_index')),
    ).toStrictEqual([]);
  });
});
