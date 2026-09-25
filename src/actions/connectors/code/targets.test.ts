import { describe, expect, it } from 'vitest';

import { OPERATOR_ID } from '../../../test-support/actions-fixtures.ts';
import {
  codeTargetInput,
  createCodeHarness,
  createCodeTarget,
} from '../../../test-support/code-connector.ts';
import { unwrapFail } from '../../../test-support/result.ts';

describe('code targets in the store (ACT-1, 13.13)', () => {
  it('13.13 ACT-1 a saved code target reads back through the repository, the list and the summary', async () => {
    const code = createCodeHarness();
    const saved = await createCodeTarget(code, { destination: { ref: 'v1.0' } });
    const { repo } = code.harness.engine.targets;
    expect(repo.findById(saved.id)).toMatchObject({
      name: 'widgets',
      connector: 'code',
      destination: { repository: 'acme/widgets', ref: 'v1.0' },
      credential: { item_id: 'item-login', mapping: { token_field: 'password' } },
    });
    expect(repo.findByName('widgets')?.id).toBe(saved.id);
    expect(
      code.harness.engine.targets.list().map((target) => [target.name, target.state]),
    ).toStrictEqual([['widgets', 'valid']]);
    expect(code.harness.engine.targets.get(saved.id)?.destinationSummary).toBe('acme/widgets@v1.0');
  });

  it('ACT-103 refuses to save a code target as internal', async () => {
    const code = createCodeHarness();
    const refused = unwrapFail(
      await code.harness.engine.targets.create(codeTargetInput({ internal: true }), OPERATOR_ID),
    );
    expect(refused.problems).toStrictEqual([
      'internal: a code target reaches GitHub over the internet and is never internal',
    ]);
  });

  it('ACT-4 ACT-112 refuses a token field the item lacks and a build wait too close to the timeout, all at once', async () => {
    const code = createCodeHarness();
    const input = codeTargetInput({
      mapping: { token_field: 'custom.github-token' },
      policy: { build_wait_s: 100, timeout_ms: 100_000 },
    });
    const refused = unwrapFail(await code.harness.engine.targets.create(input, OPERATOR_ID));
    expect(refused.problems).toStrictEqual([
      'policy.build_wait_s: must end at least 10 seconds before policy.timeout_ms',
      'credential.mapping: the item has no "custom.github-token" field',
    ]);
  });

  it('ACT-103 a public repository needs no token field at all', async () => {
    const code = createCodeHarness();
    const saved = await createCodeTarget(code, { mapping: { token_field: null } });
    expect(saved.state).toBe('valid');
    expect(
      code.github.requests.every((request) => request.headers['authorization'] === undefined),
    ).toBe(true);
  });
});
