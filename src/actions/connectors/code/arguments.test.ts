import { describe, expect, it } from 'vitest';

import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  codeInvocation,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
} from '../../../test-support/code-connector.ts';

import { pathProblem } from './tools.ts';

import type { CodeHarness } from '../../../test-support/code-connector.ts';
import type { CallOutcome } from '../../engine-context.ts';
import type { Invocation } from '../../engine-resolve.ts';

function codeOf(outcome: CallOutcome): string {
  return outcome.kind === 'error' ? outcome.error.code : outcome.kind;
}

async function outcomeCode(code: CodeHarness, invocation: Invocation): Promise<string> {
  const outcome = await code.harness.engine.call(codeCaller(), invocation);
  return codeOf(outcome);
}

describe('file paths (ACT-111)', () => {
  it('ACT-111 a path is repository-relative POSIX: absolute, "..", ".", empty segments, backslashes, NULs and over 1 024 bytes are refused', () => {
    const refused = [
      '/etc/passwd',
      '../x',
      'a/../b',
      './a',
      'a/./b',
      'a//b',
      'a/',
      '',
      String.raw`a\b`,
      'a\0b',
      'é'.repeat(513),
    ];
    expect(refused.map((path) => pathProblem(path) !== undefined)).toStrictEqual(
      refused.map(() => true),
    );
    expect(
      ['src/a.ts', '.github/x.yml', 'a..b/c', 'é'.repeat(512)].map((path) => pathProblem(path)),
    ).toStrictEqual([undefined, undefined, undefined, undefined]);
  });

  it('ACT-111 every file_path argument is checked before anything is fetched: read, related and search paths', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    const requests = code.sidecar.requests.length;
    const outcomes = [
      await code.harness.engine.call(
        codeCaller(),
        codeInvocation('code_read', 'widgets', { file_path: '../secret' }),
      ),
      await code.harness.engine.call(
        codeCaller(),
        codeInvocation('code_find_related', 'widgets', { file_path: '/abs', line: 1 }),
      ),
      await code.harness.engine.call(codeCaller(), search('widgets', { paths: [String.raw`a\b`] })),
    ];
    expect(outcomes.map((outcome) => codeOf(outcome))).toStrictEqual([
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
    ]);
    expect(code.sidecar.requests).toHaveLength(requests);
  });
});

describe('the code tools arguments (ACT-110)', () => {
  it('ACT-110 refuses out-of-range arguments as invalid_arguments', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { max_top_k: 200 } });
    const refused = [
      { query: '' },
      { query: 'q'.repeat(1001) },
      { top_k: 0 },
      { top_k: 201 },
      { max_snippet_lines: -1 },
      { max_snippet_lines: 1001 },
      { paths: Array.from({ length: 21 }, (_value, index) => `f${String(index)}.ts`) },
      { languages: Array.from({ length: 21 }, () => 'python') },
      { languages: ['python!'] },
      { ref: 'a/../b' },
      { ref: 'pr:0' },
      { content: 'tests' },
      { extra: true },
    ];
    const codes = [];
    for (const toolArguments of refused) {
      codes.push(await outcomeCode(code, search('widgets', toolArguments)));
    }
    expect(codes).toStrictEqual(refused.map(() => 'invalid_arguments'));
    const accepted = [
      { query: 'q'.repeat(1000), top_k: 200, max_snippet_lines: 1000 },
      { languages: ['c++', 'c#'] },
    ];
    for (const toolArguments of accepted) {
      expect(await outcomeCode(code, search('widgets', toolArguments))).toBe('ok');
    }
  });

  it('ACT-110 repo names 1 to 10 distinct connections, code_read one only', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    const problems = [];
    const invocations = [
      search([]),
      search(['widgets', 'widgets']),
      search(Array.from({ length: 11 }, (_value, index) => `repo-${String(index)}`)),
      codeInvocation('code_read', ['widgets', 'gadgets'], { file_path: 'a.ts' }),
    ];
    for (const invocation of invocations) {
      const outcome = await code.harness.engine.call(codeCaller(), invocation);
      problems.push(outcome.kind === 'error' && outcome.error.detail?.['problem']);
    }
    expect(problems).toStrictEqual([
      'repo: must name 1 to 10 distinct connections',
      'repo: must name 1 to 10 distinct connections',
      'repo: must name 1 to 10 distinct connections',
      'repo: must name 1 to 1 distinct connections',
    ]);
  });

  it('ACT-110 ref may be given with one repo only', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search(['widgets', 'gadgets'], { ref: 'main' }),
    );
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'invalid_arguments',
      { problem: 'ref: may be given with one repo only' },
    ]);
    expect(
      storedCalls(code.harness.database).map((row) => [row.targetName, row.outcome]),
    ).toStrictEqual([['widgets,gadgets', 'denied:invalid_arguments']]);
  });
});

describe('the code policy (ACT-110)', () => {
  it('ACT-110 a per-call ref is policy_denied ref when allow_ref is false; the configured ref still serves', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { allow_ref: false } });
    const refused = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { ref: 'v1.0' }),
    );
    expect(refused.kind === 'error' && refused.error.detail).toStrictEqual({
      reason: 'ref',
      repo: 'widgets',
    });
    expect(await outcomeCode(code, search('widgets'))).toBe('ok');
  });

  it('ACT-110 a content type the policy does not allow is policy_denied content; all and none mean every allowed type', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { content: ['docs'] } });
    const refused = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { content: 'code' }),
    );
    expect(refused.kind === 'error' && refused.error.detail).toStrictEqual({
      reason: 'content',
      repo: 'widgets',
    });
    await code.harness.engine.call(codeCaller(), search('widgets', { content: 'all' }));
    await code.harness.engine.call(codeCaller(), search('widgets', { content: 'docs' }));
    expect(code.sidecar.queries.map((query) => query.body['content'])).toStrictEqual([
      ['docs'],
      ['docs'],
    ]);
  });

  it('ACT-110 several repositories search the types every one of them allows; none shared is policy_denied content for each', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { content: ['code', 'docs'] } });
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
      policy: { content: ['docs', 'config'] },
    });
    await createCodeTarget(code, {
      name: 'configs',
      destination: { repository: OTHER_REPO },
      policy: { content: ['config'] },
    });
    await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(code.sidecar.queries.at(-1)?.body['content']).toStrictEqual(['docs']);
    const refused = await code.harness.engine.call(codeCaller(), search(['widgets', 'configs']));
    expect(refused.kind === 'error' && [refused.error.code, refused.error.detail]).toStrictEqual([
      'policy_denied',
      { reason: 'content' },
    ]);
    expect(
      storedCalls(code.harness.database)
        .slice(-2)
        .map((row) => [row.targetName, row.outcome]),
    ).toStrictEqual([
      ['widgets', 'denied:policy_denied'],
      ['configs', 'denied:policy_denied'],
    ]);
  });

  it('ACT-110 top_k above max_top_k is policy_denied top_k', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { max_top_k: 10 } });
    const refused = await code.harness.engine.call(codeCaller(), search('widgets', { top_k: 11 }));
    const related = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', { file_path: 'a.ts', line: 1, top_k: 11 }),
    );
    expect(
      [refused, related].map(
        (outcome) => outcome.kind === 'error' && outcome.error.detail?.['reason'],
      ),
    ).toStrictEqual(['top_k', 'top_k']);
    expect(await outcomeCode(code, search('widgets', { top_k: 10 }))).toBe('ok');
  });

  it('ACT-110 code_read is policy_denied read when allow_read is false; search still serves', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { allow_read: false } });
    const refused = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_read', 'widgets', { file_path: 'a.ts' }),
    );
    expect(refused.kind === 'error' && refused.error.detail).toStrictEqual({
      reason: 'read',
      repo: 'widgets',
    });
    expect(await outcomeCode(code, search('widgets'))).toBe('ok');
  });

  it('ACT-16 an ungranted repo in a list is not_granted and names the repo; a token without actions:code is insufficient_scope', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
      grantTo: [],
    });
    const refused = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(refused.kind === 'error' && [refused.error.code, refused.error.detail]).toStrictEqual([
      'not_granted',
      { repo: 'gadgets' },
    ]);
    const scoped = await code.harness.engine.call(
      codeCaller({ scopes: ['actions:http'] }),
      search('widgets'),
    );
    expect(codeOf(scoped)).toBe('insufficient_scope');
  });
});
