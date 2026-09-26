import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';

function movable(
  references: Record<string, string>,
  options: { readonly failing?: () => boolean } = {},
) {
  const code = createCodeHarness({
    github: {
      repos: [fakeRepo({ refs: references })],
      answer: () =>
        options.failing?.() === true ? new Response('down', { status: 500 }) : undefined,
    },
    sidecar: { answer: () => [sidecarResult('widgets')] },
  });
  return code;
}

function apiRequests(code: ReturnType<typeof createCodeHarness>): readonly string[] {
  return code.github.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.hostname === 'api.github.com' && !url.pathname.includes('/tarball/'))
    .map((url) => url.pathname);
}

function reposOf(
  outcome: Awaited<ReturnType<ReturnType<typeof createCodeHarness>['harness']['engine']['call']>>,
) {
  return resultOf(outcome)['repos'];
}

describe('the freshness of the configured ref (ACT-108)', () => {
  it('ACT-108 is resolved again only when its last resolution is older than refresh_interval_s', async () => {
    const code = movable({ main: SHA.main });
    await createCodeTarget(code, { policy: { refresh_interval_s: 120 } });
    expect(apiRequests(code)).toStrictEqual([
      '/repos/acme/widgets',
      '/repos/acme/widgets/commits/main',
    ]);
    await code.harness.engine.call(codeCaller(), search('widgets'));
    await code.harness.clock.advance(119_999);
    await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(apiRequests(code)).toHaveLength(2);
    await code.harness.clock.advance(1);
    await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(apiRequests(code)).toHaveLength(4);
  });

  it('ACT-117 ACT-108 a ref that moved is answered from the previous snapshot with stale: true while the new one builds', async () => {
    const references = { main: SHA.main };
    const code = movable(references);
    await createCodeTarget(code);
    references.main = SHA.moved;
    await code.harness.clock.advance(300_000);
    const release = code.sidecar.hold();
    const stale = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(stale).toStrictEqual([
      expect.objectContaining({ commit: SHA.main, ref: 'main', stale: true }),
    ]);
    await code.settle();
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([
      SHA.main,
      SHA.moved,
    ]);
    release();
    await code.settle();
    const fresh = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(fresh).toStrictEqual([expect.objectContaining({ commit: SHA.moved, stale: false })]);
    const built = code.harness.audit.filter((event) => event.action === 'code_index_built');
    expect(
      built.map((event) => [event.details?.['commit'], event.details?.['trigger']]),
    ).toStrictEqual([
      [SHA.main, 'save'],
      [SHA.moved, 'call'],
    ]);
  });

  it('ACT-108 a moved ref whose new build failed is not built again on every call', async () => {
    const references = { main: SHA.main };
    const code = movable(references);
    await createCodeTarget(code);
    references.main = SHA.moved;
    await code.harness.clock.advance(300_000);
    code.sidecar.script('build', { status: 422, body: Buffer.from('{"error":"build_failed"}') });
    await code.harness.engine.call(codeCaller(), search('widgets'));
    await code.settle();
    const again = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    await code.settle();
    expect(again).toStrictEqual([expect.objectContaining({ commit: SHA.main, stale: true })]);
    expect(code.sidecar.builds).toHaveLength(1);
    expect(
      code.github.requests.filter((request) => request.url.includes('/tarball/')),
    ).toHaveLength(2);
  });

  it('ACT-108 a failed resolution with a snapshot to answer from never fails the call; it is recorded once on the page and in the audit trail', async () => {
    let isDown = false;
    const code = movable({ main: SHA.main }, { failing: () => isDown });
    const target = await createCodeTarget(code);
    await code.harness.clock.advance(300_000);
    isDown = true;
    const first = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    const second = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect([first, second]).toStrictEqual([
      [expect.objectContaining({ commit: SHA.main, stale: false })],
      [expect.objectContaining({ commit: SHA.main, stale: false })],
    ]);
    expect(apiRequests(code)).toHaveLength(3);
    const failures = code.harness.audit.filter((event) => event.action === 'code_index_failed');
    expect(failures.map((event) => [event.outcome, event.details?.['trigger']])).toStrictEqual([
      ['error:upstream_error', 'call'],
    ]);
    const status = await code.harness.engine.code?.status(target.id);
    expect([status?.resolution, status?.lastFailure?.reason]).toStrictEqual([
      { at: code.harness.clock.now(), failure: 'upstream_error' },
      'upstream_error',
    ]);
  });

  it('ACT-108 a failed resolution without a snapshot fails the call with its code, and the next call tries again', async () => {
    const code = createCodeHarness({
      github: { answer: () => new Response(null, { status: 401 }) },
    });
    await createCodeTarget(code);
    const codes = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await code.harness.engine.call(codeCaller(), search('widgets'));
      codes.push(outcome.kind === 'error' ? outcome.error.code : outcome.kind);
    }
    expect(codes).toStrictEqual(['authentication_failed', 'authentication_failed']);
    expect(apiRequests(code)).toHaveLength(3);
  });

  it('ACT-108 a ref a call names is resolved on every call, a SHA never, and neither becomes the configured snapshot', async () => {
    const code = movable({ main: SHA.main, 'v1.0': SHA.tag });
    await createCodeTarget(code);
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: SHA.other }));
    expect(apiRequests(code)).toStrictEqual([
      '/repos/acme/widgets',
      '/repos/acme/widgets/commits/main',
      '/repos/acme/widgets/commits/v1.0',
      '/repos/acme/widgets/commits/v1.0',
    ]);
    const configured = reposOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(configured).toStrictEqual([expect.objectContaining({ ref: 'main', commit: SHA.main })]);
  });
});
