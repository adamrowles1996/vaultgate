import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all, run } from '../../../storage/query.ts';
import { OPERATOR_ID, resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  search,
  SHA,
  sidecarResult,
  type CodeHarness,
} from '../../../test-support/code-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';

import type { DatabaseSync } from 'node:sqlite';

const keptSchema = z.object({ target_id: z.string(), commit_sha: z.string(), ref: z.string() });

function kept(database: DatabaseSync): readonly z.output<typeof keptSchema>[] {
  return all(
    database,
    'SELECT target_id, commit_sha, ref FROM action_code_snapshots ORDER BY target_id',
    keptSchema,
  );
}

function reposOf(outcome: Awaited<ReturnType<CodeHarness['harness']['engine']['call']>>) {
  return resultOf(outcome)['repos'];
}

/**
 * vaultgate started again over the same database, beside the same sidecar
 * (which keeps its snapshots), with GitHub's main now at `main`.
 */
async function restarted(before: CodeHarness, main: string): Promise<CodeHarness> {
  const code = createCodeHarness({
    harness: { database: before.harness.database },
    github: { repos: [fakeRepo({ refs: { main } })] },
    sidecar: {
      seed: Array.from(before.sidecar.snapshots.values(), (snapshot) => ({ ...snapshot })),
      answer: () => [sidecarResult('w')],
    },
  });
  await code.settle();
  return code;
}

describe('the configured ref across a restart (ACT-108, 13.13)', () => {
  it('ACT-117 ACT-108 after a restart, a ref that moved is answered stale from the kept snapshot while the new one builds', async () => {
    const before = createCodeHarness();
    const target = await createCodeTarget(before);
    expect(kept(before.harness.database)).toStrictEqual([
      { target_id: target.id, commit_sha: SHA.main, ref: 'main' },
    ]);
    const code = await restarted(before, SHA.moved);
    // The start-up reconciliation keeps the snapshot calls answer from.
    expect(code.sidecar.requests.filter((request) => request.method === 'DELETE')).toStrictEqual(
      [],
    );
    const release = code.sidecar.hold();
    const stale = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(stale).toStrictEqual([
      expect.objectContaining({ commit: SHA.main, ref: 'main', stale: true }),
    ]);
    await code.settle();
    expect(
      code.sidecar.builds.map((build) => [build.spec.commit, build.spec.variants]),
    ).toStrictEqual([[SHA.moved, [['code', 'docs', 'config']]]]);
    release();
    await code.settle();
    const fresh = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(fresh).toStrictEqual([expect.objectContaining({ commit: SHA.moved, stale: false })]);
    expect(kept(code.harness.database)).toStrictEqual([
      { target_id: target.id, commit_sha: SHA.moved, ref: 'main' },
    ]);
    const page = await code.harness.engine.code?.status(target.id);
    const answering = page?.snapshots.filter((snapshot) => snapshot.current);
    expect([page?.snapshots.length, answering?.map((snapshot) => snapshot.commit)]).toStrictEqual([
      2,
      [SHA.moved],
    ]);
  });

  it('ACT-108 a kept snapshot of an extraction policy since changed is not answered from', async () => {
    const before = createCodeHarness();
    const target = await createCodeTarget(before);
    run(
      before.harness.database,
      "UPDATE action_code_snapshots SET fingerprint = '0000000000000000' WHERE target_id = ?",
      target.id,
    );
    const code = await restarted(before, SHA.moved);
    const release = code.sidecar.hold();
    const pending = code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    release();
    expect(reposOf(await pending)).toStrictEqual([
      expect.objectContaining({ commit: SHA.moved, stale: false }),
    ]);
  });

  it('ACT-108 ACT-109 13.13 Rebuild index forgets the kept snapshot, and deleting the target deletes its row', async () => {
    const code = createCodeHarness();
    const first = await createCodeTarget(code);
    const second = await createCodeTarget(code, { name: 'other' });
    expect(kept(code.harness.database).map((row) => row.target_id)).toStrictEqual([
      first.id,
      second.id,
    ]);
    const release = code.sidecar.hold();
    const rebuilt = code.harness.engine.code?.refresh(first.id, 'operator', true);
    await code.settle();
    expect(kept(code.harness.database).map((row) => row.target_id)).toStrictEqual([second.id]);
    release();
    await rebuilt;
    await code.settle();
    expect(kept(code.harness.database).map((row) => row.target_id)).toStrictEqual([
      first.id,
      second.id,
    ]);
    unwrapOk(code.harness.engine.targets.remove(second.id, OPERATOR_ID));
    await code.settle();
    expect(kept(code.harness.database).map((row) => row.target_id)).toStrictEqual([first.id]);
  });
});
