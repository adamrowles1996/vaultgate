import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';

describe('Rebuild index (ACT-108)', () => {
  it('ACT-108 Rebuild during a running build deletes it and builds afresh rather than joining the build it deleted', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    const release = code.sidecar.hold();
    const target = await createCodeTarget(code);
    const control = code.harness.engine.code;
    const rebuilt = control?.refresh(target.id, 'operator', true);
    await code.settle();
    release();
    await rebuilt;
    await code.settle();
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([
      SHA.main,
      SHA.main,
    ]);
    expect(code.sidecar.snapshots.size).toBe(1);
    const status = await control?.status(target.id);
    expect([
      status?.lastBuild?.trigger,
      status?.lastBuild?.reason,
      status?.snapshots.length,
    ]).toStrictEqual(['operator', undefined, 1]);
    const result = resultOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(result['repos']).toStrictEqual([
      expect.objectContaining({ commit: SHA.main, stale: false }),
    ]);
  });
});
