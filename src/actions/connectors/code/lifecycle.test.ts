import { describe, expect, it } from 'vitest';

import { OPERATOR_ID, resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  search,
  SHA,
  sidecarResult,
  updateCodeTarget,
} from '../../../test-support/code-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';

const STALE_KEY = `id-1.0000000000000000.${SHA.main}`;

function paths(code: ReturnType<typeof createCodeHarness>): readonly string[] {
  return code.sidecar.requests.map((request) => `${request.method} ${request.path}`);
}

function messages(code: ReturnType<typeof createCodeHarness>): readonly unknown[] {
  return code.harness.logged().map((line) => line['msg']);
}

describe('the sidecar at start-up (ACT-115)', () => {
  it('ACT-115 checks health at start-up and logs the protocol, semble version and model; the code tools are served', async () => {
    const code = createCodeHarness();
    await code.settle();
    expect(paths(code).slice(0, 2)).toStrictEqual(['GET /v1/health', 'GET /v1/snapshots']);
    expect(code.harness.logged()).toStrictEqual([
      expect.objectContaining({
        msg: 'code sidecar ready',
        protocol: 1,
        semble: '0.6.1',
        model: 'minishlab/potion-code-16M-v2',
        revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
      }),
    ]);
    expect(code.harness.engine.tools.map((tool) => tool.name)).toStrictEqual([
      'code_search',
      'code_find_related',
      'code_read',
    ]);
  });

  it('ACT-115 an incompatible protocol turns the code tools off with a start-up error, and a call answers index_unavailable', async () => {
    const code = createCodeHarness({ sidecar: { protocol: 2 } });
    await code.settle();
    await createCodeTarget(code);
    expect(code.harness.engine.tools).toStrictEqual([]);
    expect(code.harness.engine.listTargets(codeCaller())).toStrictEqual([]);
    expect(code.harness.logged()[0]).toMatchObject({
      level: 50,
      protocol: 2,
      expected: 1,
      msg: 'code sidecar protocol is incompatible; the code tools are off',
    });
    const outcome = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(outcome.kind === 'error' && outcome.error.code).toBe('index_unavailable');
  });

  it('ACT-109 reconciles at start-up: a snapshot whose target does not exist is deleted', async () => {
    const seed = [
      {
        key: `gone-1.0123456789abcdef.${SHA.main}`,
        owner: 'gone-1',
        commit: SHA.main,
        createdAt: 1,
        variants: ['code'],
      },
    ];
    const code = createCodeHarness({ sidecar: { seed } });
    await code.settle();
    expect(code.sidecar.snapshots.size).toBe(0);
    expect(paths(code)).toContain('DELETE /v1/owners/gone-1');
  });
});

describe('an unreachable sidecar (ACT-109, ACT-113)', () => {
  it('ACT-113 a sidecar that does not answer makes a call index_unavailable; the tools stay, as it is not incompatible', async () => {
    const code = createCodeHarness({ startUnreachable: true });
    await createCodeTarget(code);
    expect(messages(code)).toContain('code sidecar not answering yet');
    const outcome = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(outcome.kind === 'error' && outcome.error.code).toBe('index_unavailable');
    expect(code.harness.engine.tools).toHaveLength(3);
  });

  it('ACT-117 ACT-109 ACT-115 found reachable again, the sidecar is checked and reconciled before it serves on', async () => {
    const code = createCodeHarness({
      sidecar: { answer: () => [sidecarResult('widgets')] },
      startUnreachable: true,
    });
    await createCodeTarget(code);
    code.sidecar.snapshots.set(STALE_KEY, {
      key: STALE_KEY,
      owner: 'id-1',
      commit: SHA.main,
      createdAt: 1,
      variants: ['code'],
    });
    code.sidecar.snapshots.set('gone-1.x', {
      key: 'gone-1.x',
      owner: 'gone-1',
      commit: SHA.main,
      createdAt: 1,
      variants: ['code'],
    });
    code.sidecar.unreachable(false);
    const first = await code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    expect(first.kind).toBe('ok');
    expect(paths(code)).toStrictEqual(
      expect.arrayContaining([
        'GET /v1/health',
        `DELETE /v1/snapshots/${STALE_KEY}`,
        'DELETE /v1/owners/gone-1',
      ]),
    );
    expect([
      code.sidecar.snapshots.has(STALE_KEY),
      code.sidecar.snapshots.has('gone-1.x'),
    ]).toStrictEqual([false, false]);
    const checks = paths(code).filter((path) => path === 'GET /v1/health');
    await code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    expect(paths(code).filter((path) => path === 'GET /v1/health')).toStrictEqual(checks);
  });
});

describe('deleting a target (ACT-109)', () => {
  it('ACT-117 ACT-109 tells the sidecar to delete every snapshot of the target before the row is removed', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    expect(code.sidecar.snapshots.size).toBe(1);
    unwrapOk(code.harness.engine.targets.remove(target.id, OPERATOR_ID));
    await code.settle();
    expect(paths(code).at(-1)).toBe(`DELETE /v1/owners/${target.id}`);
    expect(code.sidecar.snapshots.size).toBe(0);
    expect(await code.harness.engine.code?.status(target.id)).toMatchObject({
      snapshots: [],
      lastBuild: undefined,
    });
  });

  it('ACT-109 an unreachable sidecar does not block the deletion, and the next reconciliation deletes the snapshots', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    code.sidecar.unreachable(true);
    unwrapOk(code.harness.engine.targets.remove(target.id, OPERATOR_ID));
    await code.settle();
    expect(code.harness.engine.targets.get(target.id)).toBeUndefined();
    expect(code.harness.logged().at(-1)).toMatchObject({
      level: 40,
      target: target.id,
      reason: 'index_unavailable',
      msg: 'code snapshots not deleted yet; the next reconciliation deletes them',
    });
    expect(code.sidecar.snapshots.size).toBe(1);
    code.sidecar.unreachable(false);
    await code.harness.engine.code?.status(target.id);
    await code.settle();
    expect(code.sidecar.snapshots.size).toBe(0);
  });
});

describe('a revision (ACT-108)', () => {
  it('ACT-108 a revision that changes the ref deletes every snapshot first, then builds the new ref', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    await updateCodeTarget(code, target.id, { destination: { ref: 'v1.0' } });
    const tail = paths(code).slice(-3);
    expect(tail[0]).toBe(`DELETE /v1/owners/${target.id}`);
    expect(
      Array.from(code.sidecar.snapshots.values(), (snapshot) => snapshot.commit),
    ).toStrictEqual([SHA.tag]);
  });

  it('ACT-108 a revision that changes nothing the snapshots were built from deletes nothing and fetches no archive again', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    const tarballs = code.github.requests.filter((request) =>
      request.url.includes('/tarball/'),
    ).length;
    await updateCodeTarget(code, target.id, { policy: { max_top_k: 10 } });
    expect(paths(code).some((path) => path.startsWith('DELETE'))).toBe(false);
    expect(
      code.github.requests.filter((request) => request.url.includes('/tarball/')),
    ).toHaveLength(tarballs);
    expect(code.sidecar.snapshots.size).toBe(1);
    const result = resultOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(result['repos']).toStrictEqual([expect.objectContaining({ commit: SHA.main })]);
  });

  it('ACT-108 a disabled target whose extraction changes loses its snapshots and builds nothing', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    code.harness.engine.targets.setEnabled(target.id, false, OPERATOR_ID);
    await code.settle();
    await updateCodeTarget(code, target.id, { policy: { exclude: ['vendor/'] } });
    expect(code.sidecar.snapshots.size).toBe(0);
    expect(code.sidecar.builds).toHaveLength(1);
  });
});
