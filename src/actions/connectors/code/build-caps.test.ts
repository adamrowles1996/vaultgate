import { describe, expect, it } from 'vitest';

import { OPERATOR_ID } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';

import type { CallOutcome } from '../../engine.ts';

type Code = ReturnType<typeof createCodeHarness>;

/**
The commit of every archive vaultgate asked GitHub for, in order.
*/
function tarballs(code: Code): readonly string[] {
  return code.github.requests
    .map((request) => new URL(request.url).pathname)
    .filter((path) => path.includes('/tarball/'))
    .map((path) => path.slice(path.lastIndexOf('/') + 1));
}

function errorOf(outcome: CallOutcome | undefined): readonly unknown[] {
  return outcome?.kind === 'error' ? [outcome.error.code, outcome.error.detail] : [outcome?.kind];
}

/**
Calls that name these refs on `repo`, answered at once (`build_wait_s` 0) while their builds carry on.
*/
async function named(
  code: Code,
  repo: string,
  references: readonly string[],
): Promise<CallOutcome[]> {
  const pending = references.map((reference) =>
    code.harness.engine.call(codeCaller(), search(repo, { ref: reference })),
  );
  await code.harness.clock.advance(0);
  return Promise.all(pending);
}

function harness(): Code {
  return createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
}

const NOW = { policy: { build_wait_s: 0 } };

describe('the caps on the builds calls start (ACT-108, ACT-112, T46)', () => {
  it('ACT-108 T46 one target builds at most two refs calls named; a third answers rate_limited and fetches nothing', async () => {
    const code = harness();
    await createCodeTarget(code, NOW);
    const release = code.sidecar.hold();
    const building = await named(code, 'widgets', ['v1.0', 'feature/x']);
    expect(building.map((outcome) => errorOf(outcome))).toStrictEqual([
      ['index_not_ready', { state: 'building', repo: 'widgets' }],
      ['index_not_ready', { state: 'building', repo: 'widgets' }],
    ]);
    const refused = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'pr:7' }),
    );
    expect(errorOf(refused)).toStrictEqual([
      'rate_limited',
      { retry_after_s: 30, repo: 'widgets' },
    ]);
    expect(tarballs(code)).toStrictEqual([SHA.main, SHA.tag, SHA.moved]);
    // A refused build is not a build: no event, and nothing on the page.
    expect(code.harness.audit.map((event) => event.action)).not.toContain('code_index_failed');
    // A ref already building is joined, and the configured ref needs no new slot.
    const [joined] = await named(code, 'widgets', ['v1.0']);
    expect(errorOf(joined)).toStrictEqual([
      'index_not_ready',
      { state: 'building', repo: 'widgets' },
    ]);
    const configured = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(configured.kind).toBe('ok');
    release();
    await code.settle();
    const later = await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'pr:7' }));
    expect(later.kind).toBe('ok');
    expect(tarballs(code)).toStrictEqual([SHA.main, SHA.tag, SHA.moved, SHA.pull]);
  });

  it('ACT-108 T46 four builds run at once in all: a named ref past that is refused, and a save waits for a slot', async () => {
    const code = harness();
    await createCodeTarget(code, NOW);
    await createCodeTarget(code, {
      ...NOW,
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
    });
    const release = code.sidecar.hold();
    await named(code, 'widgets', ['v1.0', 'feature/x']);
    await named(code, 'gadgets', [SHA.tag, SHA.moved]);
    expect(code.sidecar.builds).toHaveLength(6);
    const third = unwrapOk(
      await code.harness.engine.targets.create(
        {
          name: 'third',
          description: 'A third repository',
          connector: 'code',
          destination: { repository: 'acme/widgets', ref: 'v1.0' },
          internal: false,
          credential: { item_id: 'item-login', mapping: { token_field: 'password' } },
          policy: { build_wait_s: 0 },
          enabled: true,
        },
        OPERATOR_ID,
      ),
    );
    unwrapOk(code.harness.engine.targets.grant(third.id, 'vg_c_agent', OPERATOR_ID));
    await code.settle();
    // The save resolved its ref and waits for a slot: no archive yet, and no refusal.
    expect(code.sidecar.builds).toHaveLength(6);
    const [refused] = await named(code, 'third', ['feature/x']);
    expect(errorOf(refused)).toStrictEqual(['rate_limited', { retry_after_s: 30, repo: 'third' }]);
    release();
    await code.settle();
    const saved = code.sidecar.builds.at(-1);
    expect([saved?.spec.owner, saved?.spec.commit]).toStrictEqual([third.id, SHA.tag]);
    const answered = await code.harness.engine.call(codeCaller(), search('third'));
    expect(answered.kind).toBe('ok');
  });

  it('ACT-109 T46 a build whose target is deleted while it waits for its slot never downloads', async () => {
    const code = harness();
    await createCodeTarget(code, NOW);
    await createCodeTarget(code, {
      ...NOW,
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
    });
    const release = code.sidecar.hold();
    await named(code, 'widgets', ['v1.0', 'feature/x']);
    await named(code, 'gadgets', [SHA.tag, SHA.moved]);
    const doomed = await createCodeTarget(code, { ...NOW, name: 'doomed', grantTo: [] });
    const fetched = tarballs(code).length;
    unwrapOk(code.harness.engine.targets.remove(doomed.id, OPERATOR_ID));
    await code.settle();
    release();
    await code.settle();
    expect(tarballs(code)).toHaveLength(fetched);
    expect(code.sidecar.builds.map((build) => build.spec.owner)).not.toContain(doomed.id);
    const never = code.harness.audit.find(
      (event) => event.action === 'code_index_failed' && event.details?.['target'] === 'doomed',
    );
    expect([never?.outcome, never?.details?.['trigger']]).toStrictEqual([
      'error:target_changed',
      'save',
    ]);
  });
});
