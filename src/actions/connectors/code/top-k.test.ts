import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  codeCaller,
  codeInvocation,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
  sidecarResult,
} from '../../../test-support/code-connector.ts';

import { CODE_TOOLS } from './tools.ts';

function harness() {
  return createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
}

function topKs(code: ReturnType<typeof harness>): readonly unknown[] {
  return code.sidecar.queries.map((query) => query.body['top_k']);
}

describe('top_k when a call leaves it out (ACT-110, 14.8.6)', () => {
  it('ACT-110 is 5, or a max_top_k below 5, so a connection that caps it lower still answers a default call', async () => {
    const code = harness();
    await createCodeTarget(code, { policy: { max_top_k: 3 } });
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    const capped = await code.harness.engine.call(codeCaller(), search('widgets'));
    const related = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', { file_path: 'src/widget.ts', line: 10 }),
    );
    const plain = await code.harness.engine.call(codeCaller(), search('gadgets'));
    const both = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect([capped.kind, related.kind, plain.kind, both.kind]).toStrictEqual([
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(topKs(code)).toStrictEqual([3, 3, 5, 3]);
  });

  it('ACT-110 a top_k the call gives is used as it is, and one above max_top_k is still refused', async () => {
    const code = harness();
    await createCodeTarget(code, { policy: { max_top_k: 3 } });
    const given = await code.harness.engine.call(codeCaller(), search('widgets', { top_k: 2 }));
    const above = await code.harness.engine.call(codeCaller(), search('widgets', { top_k: 5 }));
    expect(given.kind).toBe('ok');
    expect(above.kind === 'error' && [above.error.code, above.error.detail]).toStrictEqual([
      'policy_denied',
      { reason: 'top_k', repo: 'widgets' },
    ]);
    expect(topKs(code)).toStrictEqual([2]);
  });

  it('14.8.6 the tools still advertise semble’s default of 5, and say a connection may lower it', () => {
    const minimal: Readonly<Record<string, unknown>> = {
      code_search: { query: 'q' },
      code_find_related: { file_path: 'a', line: 1 },
    };
    for (const [name, input] of Object.entries(minimal)) {
      const tool = CODE_TOOLS.find((candidate) => candidate.name === name);
      const schema = z.toJSONSchema(tool?.inputSchema ?? z.never(), { io: 'input' });
      const topK: unknown = schema.properties?.['top_k'];
      expect(topK).toMatchObject({ default: 5, type: 'integer', minimum: 1, maximum: 200 });
      expect(JSON.stringify(topK)).toContain(
        'Default 5, or the connection’s own maximum when that is lower.',
      );
      expect(tool?.inputSchema.parse(input)).not.toHaveProperty('top_k');
    }
  });
});
