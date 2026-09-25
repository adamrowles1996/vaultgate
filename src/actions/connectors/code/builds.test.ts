import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  ARCHIVE,
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';
import { surfaces } from '../../../test-support/http-connector.ts';

import { DEFAULT_EXCLUDE } from './schemas.ts';

const MIB = 1024 * 1024;

function tarballRequests(code: ReturnType<typeof createCodeHarness>): readonly string[] {
  return code.github.requests
    .map((request) => new URL(request.url).pathname)
    .filter((path) => path.includes('/tarball/'));
}

describe('the build on save (ACT-105, ACT-108)', () => {
  it("ACT-108 saving an enabled target builds the configured ref's snapshot and the index of the whole content, in the background", async () => {
    const code = createCodeHarness();
    const release = code.sidecar.hold();
    const target = await createCodeTarget(code);
    expect([code.sidecar.builds.length, code.sidecar.snapshots.size]).toStrictEqual([1, 0]);
    release();
    await code.settle();
    const [build] = code.sidecar.builds;
    expect(build?.spec).toStrictEqual({
      owner: target.id,
      commit: SHA.main,
      include: [],
      exclude: [...DEFAULT_EXCLUDE],
      max_archive_bytes: 256 * MIB,
      max_files: 50_000,
      max_total_bytes: 1024 * MIB,
      max_file_bytes: MIB,
      build_timeout_s: 600,
      variants: [['code', 'docs', 'config']],
    });
    expect(build?.key).toMatch(
      new RegExp(String.raw`^${target.id}\.[\da-f]{16}\.${SHA.main}$`, 'u'),
    );
    expect([
      code.sidecar.snapshots.size,
      code.sidecar.snapshots.has(build?.key ?? ''),
    ]).toStrictEqual([1, true]);
  });

  it('ACT-105 streams the archive to the sidecar exactly as GitHub sent it, and keeps none of it', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    expect(code.sidecar.builds[0]?.archive).toStrictEqual(ARCHIVE);
    const everything = surfaces(code.harness, [code.harness.engine.targets.list()]);
    expect(everything).not.toContain('ARCHIVE-CONTENT-MARKER');
  });

  it('ACT-105 cuts the stream at max_archive_bytes, which fails the build with archive_too_large', async () => {
    const big = Buffer.alloc(MIB + 64 * 1024, 7);
    const code = createCodeHarness({
      github: { repos: [fakeRepo({ archives: { [SHA.main]: big } })] },
    });
    await createCodeTarget(code, { policy: { max_archive_bytes: MIB } });
    expect(code.sidecar.snapshots.size).toBe(0);
    expect(code.sidecar.cut).toHaveLength(1);
    expect(code.sidecar.cut[0]?.bytes).toBeLessThanOrEqual(MIB);
    const failed = code.harness.audit.find((event) => event.action === 'code_index_failed');
    expect(failed?.details?.['reason']).toBe('archive_too_large');
    const status = await code.harness.engine.code?.status('id-1');
    expect(status?.lastFailure?.reason).toBe('archive_too_large');
  });

  it('ACT-108 does not build a disabled target, and builds it when it is enabled', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code, { enabled: false });
    expect(code.sidecar.builds).toStrictEqual([]);
    code.harness.engine.targets.setEnabled(target.id, true, 'operator-1');
    await code.settle();
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([SHA.main]);
    code.harness.engine.targets.setEnabled(target.id, false, 'operator-1');
    await code.settle();
    expect(code.sidecar.builds).toHaveLength(1);
    expect(code.sidecar.snapshots.size).toBe(1);
  });

  it('ACT-108 builds the configured ref when there is one', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { destination: { ref: 'v1.0' } });
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([SHA.tag]);
  });
});

describe('single flight and the wait (ACT-108, ACT-112)', () => {
  it('ACT-108 one build runs per target and commit: a call that needs it joins the save build', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    const release = code.sidecar.hold();
    await createCodeTarget(code);
    const pending = code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    release();
    const result = resultOf(await pending);
    expect(result['repos']).toStrictEqual([
      expect.objectContaining({ commit: SHA.main, stale: false }),
    ]);
    expect([code.sidecar.builds.length, tarballRequests(code).length]).toStrictEqual([1, 1]);
  });

  it('ACT-112 a call waits up to build_wait_s, then answers index_not_ready building; the build carries on and a later call finds it', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code, { policy: { build_wait_s: 30 } });
    const release = code.sidecar.hold();
    let isAnswered = false;
    const pending = code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    void pending.then(() => {
      isAnswered = true;
    });
    await code.harness.clock.advance(29_999);
    expect(isAnswered).toBe(false);
    await code.harness.clock.advance(1);
    const outcome = await pending;
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'index_not_ready',
      { state: 'building', repo: 'widgets' },
    ]);
    release();
    await code.settle();
    const later = resultOf(
      await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' })),
    );
    expect(later['repos']).toStrictEqual([expect.objectContaining({ commit: SHA.tag })]);
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([
      SHA.main,
      SHA.tag,
    ]);
  });

  it('ACT-112 several repositories wait for the smallest build_wait_s among them, their builds all started at once', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    const release = code.sidecar.hold();
    await createCodeTarget(code, { policy: { build_wait_s: 60 } });
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
      policy: { build_wait_s: 20 },
    });
    let isAnswered = false;
    const pending = code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    void pending.then(() => {
      isAnswered = true;
    });
    await code.harness.clock.advance(19_999);
    expect(isAnswered).toBe(false);
    await code.harness.clock.advance(1);
    const outcome = await pending;
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'index_not_ready',
      { state: 'building', repo: 'widgets' },
    ]);
    release();
  });

  it('ACT-112 several repositories whose snapshots are missing start every build before waiting', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    code.sidecar.snapshots.clear();
    const release = code.sidecar.hold();
    const pending = code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    await code.settle();
    expect(code.sidecar.builds).toHaveLength(4);
    release();
    const outcome = await pending;
    expect(outcome.kind).toBe('ok');
  });

  it('ACT-112 a failed build answers index_not_ready failed with the reason code and no message', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    code.sidecar.script('build', {
      status: 422,
      body: Buffer.from(
        '{"error":"build_timeout","message":"semble took 601 s over src/secret.ts"}',
      ),
    });
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets', reason: 'build_timeout' },
    ]);
  });

  it('ACT-112 a build that just failed is not fetched again until refresh_interval_s has passed', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    code.sidecar.script('build', { status: 507, body: Buffer.from('{"error":"storage_full"}') });
    await createCodeTarget(code, { policy: { refresh_interval_s: 60 } });
    const first = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(first.kind === 'error' && first.error.detail).toStrictEqual({
      state: 'failed',
      repo: 'widgets',
      reason: 'storage_full',
    });
    expect(tarballRequests(code)).toHaveLength(1);
    await code.harness.clock.advance(60_000);
    const later = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(later.kind).toBe('ok');
    expect(tarballRequests(code)).toHaveLength(2);
  });
});
