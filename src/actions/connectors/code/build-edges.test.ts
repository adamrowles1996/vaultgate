import { describe, expect, it } from 'vitest';

import { OPERATOR_ID, resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
  updateCodeTarget,
} from '../../../test-support/code-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';
import { VaultError } from '../../../vault/client.ts';

import type { CallOutcome } from '../../engine-context.ts';

function failure(outcome: CallOutcome): unknown {
  return outcome.kind === 'error' ? [outcome.error.code, outcome.error.detail] : outcome.kind;
}

const ANSWER = { answer: () => [sidecarResult('widgets')] };

describe('builds that do not finish well (ACT-107, ACT-112)', () => {
  it('ACT-107 a build that outlives build_timeout_s and the download allowance is cancelled as timeout, and changes nothing built', async () => {
    const code = createCodeHarness();
    code.sidecar.script('build', 'hang');
    const target = await createCodeTarget(code, { policy: { build_timeout_s: 60 } });
    await code.harness.clock.advance(60_000 + 300_000);
    await code.settle();
    const status = await code.harness.engine.code?.status(target.id);
    expect([status?.lastFailure?.reason, status?.snapshots]).toStrictEqual(['timeout', []]);
  });

  it('ACT-112 a call whose build cannot download the archive answers index_not_ready failed with the code, and fetches it again next time', async () => {
    let isDown = true;
    const code = createCodeHarness({
      github: {
        answer: (url) =>
          isDown && url.pathname.includes('/tarball/')
            ? new Response('no', { status: 502 })
            : undefined,
      },
      sidecar: ANSWER,
    });
    await createCodeTarget(code);
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(failure(outcome)).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets', reason: 'upstream_error' },
    ]);
    isDown = false;
    const again = await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    expect(again.kind).toBe('ok');
  });

  it('ACT-113 a call whose build finds the sidecar gone answers index_unavailable', async () => {
    const code = createCodeHarness({ sidecar: ANSWER });
    await createCodeTarget(code);
    code.sidecar.script('build', 'unreachable');
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(failure(outcome)).toStrictEqual(['index_unavailable', undefined]);
  });

  it('ACT-54 a call whose build cannot borrow the credential answers index_not_ready failed credential_unavailable', async () => {
    const code = createCodeHarness({ sidecar: ANSWER });
    await createCodeTarget(code);
    const { vault } = code.harness;
    const getSecret = vault.getSecret.bind(vault);
    let calls = 0;
    vault.getSecret = (id, field) => {
      calls += 1;
      return calls === 1
        ? getSecret(id, field)
        : Promise.resolve({ ok: false, error: new VaultError('vault_unavailable', 'locked') });
    };
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(failure(outcome)).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets', reason: 'credential_unavailable' },
    ]);
  });

  it('ACT-108 a build whose target changed its extraction since the call began is refused as target_changed', async () => {
    const pending = Promise.withResolvers<Response>();
    const code = createCodeHarness({
      github: {
        answer: (url) => (url.pathname.endsWith('/commits/v1.0') ? pending.promise : undefined),
      },
      sidecar: ANSWER,
    });
    const target = await createCodeTarget(code);
    const call = code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    await code.settle();
    await updateCodeTarget(code, target.id, { policy: { exclude: ['vendor/'] } });
    pending.resolve(new Response(SHA.tag, { status: 200 }));
    expect(failure(await call)).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets', reason: 'target_changed' },
    ]);
  });
});

describe('builds in flight (ACT-108, ACT-115)', () => {
  it('ACT-115 a build still downloading from GitHub shows as building before the sidecar has heard of it', async () => {
    const tarball = Promise.withResolvers<Response>();
    const code = createCodeHarness({
      github: {
        answer: (url) => (url.pathname.includes('/tarball/') ? tarball.promise : undefined),
      },
    });
    const target = await createCodeTarget(code);
    const during = await code.harness.engine.code?.status(target.id);
    expect([during?.building, code.sidecar.builds]).toStrictEqual([true, []]);
    tarball.resolve(new Response('no', { status: 500 }));
    await code.settle();
    const after = await code.harness.engine.code?.status(target.id);
    expect(after?.building).toBe(false);
  });

  it("ACT-109 deleting one target abandons its build and leaves another target's build to finish", async () => {
    const code = createCodeHarness();
    const release = code.sidecar.hold();
    const widgets = await createCodeTarget(code);
    const gadgets = await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
    });
    unwrapOk(code.harness.engine.targets.remove(widgets.id, OPERATOR_ID));
    await code.settle();
    release();
    await code.settle();
    expect(Array.from(code.sidecar.snapshots.values(), (snapshot) => snapshot.owner)).toStrictEqual(
      [gadgets.id],
    );
    const status = await code.harness.engine.code?.status(gadgets.id);
    expect(status?.snapshots.map((snapshot) => snapshot.current)).toStrictEqual([true]);
  });

  it('ACT-108 a build of an older commit that finishes after the ref moved on is kept but never answered from', async () => {
    const references = { main: SHA.main };
    const code = createCodeHarness({
      github: { repos: [fakeRepo({ refs: references })] },
      sidecar: ANSWER,
    });
    const release = code.sidecar.hold();
    const target = await createCodeTarget(code);
    references.main = SHA.moved;
    await code.harness.clock.advance(300_000);
    const call = code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    release();
    const repos = resultOf(await call)['repos'];
    await code.settle();
    expect(repos).toStrictEqual([expect.objectContaining({ commit: SHA.moved, stale: false })]);
    const status = await code.harness.engine.code?.status(target.id);
    expect(status?.snapshots.map((snapshot) => [snapshot.commit, snapshot.current])).toStrictEqual(
      expect.arrayContaining([
        [SHA.main, false],
        [SHA.moved, true],
      ]),
    );
  });

  it('ACT-107 a snapshot of another ref the sidecar evicted is forgotten without losing the configured one', async () => {
    const code = createCodeHarness({ sidecar: ANSWER });
    const target = await createCodeTarget(code);
    code.sidecar.script('search', {
      status: 404,
      body: Buffer.from('{"error":"snapshot_missing"}'),
    });
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(outcome.kind).toBe('ok');
    const status = await code.harness.engine.code?.status(target.id);
    expect(status?.snapshots.map((snapshot) => [snapshot.commit, snapshot.current])).toStrictEqual(
      expect.arrayContaining([
        [SHA.main, true],
        [SHA.tag, false],
      ]),
    );
  });

  it('ACT-107 a snapshot the sidecar evicted since is looked up again and the call still answers', async () => {
    const code = createCodeHarness({ sidecar: ANSWER });
    await createCodeTarget(code);
    code.sidecar.script('search', {
      status: 404,
      body: Buffer.from('{"error":"snapshot_missing","detail":{"key":"k"}}'),
    });
    const statuses = code.sidecar.requests.filter(
      (request) => request.method === 'GET' && request.path.startsWith('/v1/snapshots/'),
    ).length;
    const outcome = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(outcome.kind).toBe('ok');
    const after = code.sidecar.requests.filter(
      (request) => request.method === 'GET' && request.path.startsWith('/v1/snapshots/'),
    ).length;
    // One lookup per preparation: the first, and the one after the eviction.
    expect(after - statuses).toBe(2);
    expect(code.sidecar.queries.filter((query) => query.path === '/v1/search')).toHaveLength(1);
  });
});
