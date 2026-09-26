import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';

import type { CallOutcome } from '../../engine.ts';

type Code = ReturnType<typeof createCodeHarness>;

function errorOf(outcome: CallOutcome): readonly unknown[] {
  return outcome.kind === 'error' ? [outcome.error.code, outcome.error.detail] : [outcome.kind];
}

/**
Widgets (whose main a test may move) and gadgets, both built; gadgets' snapshot key.
*/
async function twoRepositories(references: Record<string, string>) {
  const code = createCodeHarness({
    github: {
      repos: [
        fakeRepo({ refs: references }),
        fakeRepo({ fullName: OTHER_REPO, refs: { main: SHA.other } }),
      ],
    },
    sidecar: { answer: () => [sidecarResult('widgets')] },
  });
  await createCodeTarget(code, { policy: { build_wait_s: 0 } });
  const gadgets = await createCodeTarget(code, {
    name: 'gadgets',
    destination: { repository: OTHER_REPO },
  });
  let key = '';
  for (const snapshot of code.sidecar.snapshots.values()) {
    key = snapshot.owner === gadgets.id ? snapshot.key : key;
  }
  return { code, key };
}

function refusal(status: number, body: Readonly<Record<string, unknown>>) {
  return { status, body: Buffer.from(JSON.stringify(body)) };
}

async function both(code: Code): Promise<CallOutcome> {
  const pending = code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
  await code.harness.clock.advance(0);
  return pending;
}

describe('errors of one repository of several (ACT-110, ACT-112)', () => {
  it('ACT-110 a repository of several that cannot be prepared is named in detail.repo', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code);
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO, ref: 'gone' },
    });
    expect(errorOf(await both(code))).toStrictEqual(['ref_not_found', { repo: 'gadgets' }]);
  });

  it('ACT-110 ACT-112 a sidecar refusal that names a snapshot names its repository, and one that names none names them all', async () => {
    const { code, key } = await twoRepositories({ main: SHA.main });
    code.sidecar.script(
      'search',
      refusal(422, { error: 'build_failed', detail: { key, variant: 'code' } }),
    );
    expect(errorOf(await both(code))).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'gadgets', reason: 'build_failed' },
    ]);
    code.sidecar.script(
      'search',
      refusal(422, { error: 'build_failed', detail: { key: 'Not A Key' } }),
    );
    expect(errorOf(await both(code))).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets,gadgets', reason: 'build_failed' },
    ]);
  });

  it('ACT-108 ACT-112 snapshot_missing forgets only the snapshot it names: another repository still answers stale', async () => {
    const references = { main: SHA.main };
    const { code, key } = await twoRepositories(references);
    references.main = SHA.moved;
    await code.harness.clock.advance(300_000);
    const release = code.sidecar.hold();
    code.sidecar.script('search', refusal(404, { error: 'snapshot_missing', detail: { key } }));
    const outcome = await both(code);
    expect(resultOf(outcome)['repos']).toStrictEqual([
      expect.objectContaining({ repo: 'widgets', commit: SHA.main, stale: true }),
      expect.objectContaining({ repo: 'gadgets', commit: SHA.other, stale: false }),
    ]);
    release();
  });
});
