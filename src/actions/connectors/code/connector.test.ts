import { describe, expect, it } from 'vitest';

import { resultOf, storedCalls } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  codeInvocation,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';

import type { FakeQuery } from '../../../test-support/fake-code-sidecar.ts';

function bareResult() {
  return [{ label: 'widgets', file_path: 'README.md', start_line: 1, end_line: 3, score: 0.5 }];
}

function answerFor(query: FakeQuery) {
  const indexes = query.body['indexes'] as readonly { readonly label: string }[];
  return indexes.map((index) => sidecarResult(index.label));
}

describe('code_search through the engine (ACT-110)', () => {
  it("ACT-110 ACT-112 answers { query, results, repos } in semble's fields, from the configured ref's snapshot", async () => {
    const code = createCodeHarness({ sidecar: { answer: answerFor } });
    await createCodeTarget(code);
    const result = resultOf(await code.harness.engine.call(codeCaller(), search('widgets')));
    expect(result).toStrictEqual({
      query: 'where are widgets made',
      results: [
        {
          repo: 'widgets',
          file_path: 'src/widget.ts',
          start_line: 10,
          end_line: 20,
          score: 0.83,
          language: 'typescript',
          content: 'export function makeWidget() {}',
        },
      ],
      repos: [
        {
          repo: 'widgets',
          repository: 'acme/widgets',
          ref: 'main',
          commit: SHA.main,
          indexed_at: code.harness.clock.now(),
          stale: false,
        },
      ],
      truncated: false,
      duration_ms: 0,
    });
  });

  it("ACT-110 passes semble's arguments with its defaults: top_k 5, max_snippet_lines 10, every allowed content type", async () => {
    const code = createCodeHarness();
    await createCodeTarget(code, { policy: { content: ['docs', 'code'] } });
    await code.harness.engine.call(codeCaller(), search('widgets'));
    await code.harness.engine.call(
      codeCaller(),
      search('widgets', {
        top_k: 7,
        max_snippet_lines: null,
        content: 'docs',
        paths: ['src/widget.ts'],
        languages: ['typescript', 'c++'],
      }),
    );
    await code.harness.engine.call(
      codeCaller(),
      search('widgets', { max_snippet_lines: 0, content: 'all' }),
    );
    const [key] = code.sidecar.snapshots.keys();
    const indexes = [{ key, label: 'widgets' }];
    expect(code.sidecar.queries.map((query) => query.body)).toStrictEqual([
      {
        indexes,
        content: ['code', 'docs'],
        query: 'where are widgets made',
        top_k: 5,
        max_snippet_lines: 10,
      },
      {
        indexes,
        content: ['docs'],
        query: 'where are widgets made',
        top_k: 7,
        max_snippet_lines: null,
        paths: ['src/widget.ts'],
        languages: ['typescript', 'c++'],
      },
      {
        indexes,
        content: ['code', 'docs'],
        query: 'where are widgets made',
        top_k: 5,
        max_snippet_lines: 0,
      },
    ]);
  });

  it("ACT-110 keeps semble's content rule: a result without content has none, and a missing language is null", async () => {
    const code = createCodeHarness({ sidecar: { answer: bareResult } });
    await createCodeTarget(code);
    const result = resultOf(
      await code.harness.engine.call(codeCaller(), search('widgets', { max_snippet_lines: 0 })),
    );
    expect(result['results']).toStrictEqual([
      {
        repo: 'widgets',
        file_path: 'README.md',
        start_line: 1,
        end_line: 3,
        score: 0.5,
        language: null,
      },
    ]);
  });

  it('ACT-110 searches several repos together, every file_path prefixed with its connection name', async () => {
    const code = createCodeHarness({ sidecar: { answer: answerFor } });
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    const result = resultOf(
      await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets'])),
    );
    expect(result['results']).toStrictEqual([
      expect.objectContaining({ repo: 'widgets', file_path: 'widgets/src/widget.ts' }),
      expect.objectContaining({ repo: 'gadgets', file_path: 'gadgets/src/widget.ts' }),
    ]);
    expect(result['repos']).toStrictEqual([
      expect.objectContaining({ repo: 'widgets', repository: 'acme/widgets', commit: SHA.main }),
      expect.objectContaining({ repo: 'gadgets', repository: 'acme/gadgets', commit: SHA.other }),
    ]);
    const [query] = code.sidecar.queries;
    expect(
      (query?.body['indexes'] as { label: string }[]).map((index) => index.label),
    ).toStrictEqual(['widgets', 'gadgets']);
  });

  it('ACT-110 a list of one repo is one repo: paths keep no prefix and ref is allowed', async () => {
    const code = createCodeHarness({ sidecar: { answer: answerFor } });
    await createCodeTarget(code);
    const result = resultOf(
      await code.harness.engine.call(codeCaller(), search(['widgets'], { ref: 'v1.0' })),
    );
    expect(result['results']).toStrictEqual([
      expect.objectContaining({ file_path: 'src/widget.ts' }),
    ]);
    expect(result['repos']).toStrictEqual([
      expect.objectContaining({ ref: 'v1.0', commit: SHA.tag }),
    ]);
  });
});

describe('code_find_related and code_read through the engine (ACT-110, ACT-111)', () => {
  it('ACT-110 find_related passes the location and answers like a search', async () => {
    const code = createCodeHarness({ sidecar: { answer: answerFor } });
    await createCodeTarget(code);
    const outcome = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', {
        file_path: 'src/widget.ts',
        line: 12,
        top_k: 3,
      }),
    );
    const result = resultOf(outcome);
    expect([result['query'], (result['results'] as unknown[]).length]).toStrictEqual([
      'Chunks related to src/widget.ts:12',
      1,
    ]);
    expect(code.sidecar.queries[0]?.body).toStrictEqual({
      indexes: [{ key: code.sidecar.builds[0]?.key, label: 'widgets' }],
      content: ['code', 'docs', 'config'],
      file_path: 'src/widget.ts',
      line: 12,
      top_k: 3,
      max_snippet_lines: 10,
    });
  });

  it('ACT-111 a line no indexed chunk holds is chunk_not_found', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    const outcome = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', { file_path: 'src/widget.ts', line: 900 }),
    );
    expect(outcome.kind === 'error' && outcome.error.code).toBe('chunk_not_found');
  });

  it('ACT-110 code_read answers the lines with the commit, at most max_read_lines of them', async () => {
    const files = { 'src/widget.ts': 'one\ntwo\nthree\nfour\nfive' };
    const code = createCodeHarness({ sidecar: { files } });
    await createCodeTarget(code, { policy: { max_read_lines: 2 } });
    const read = (toolArguments: Readonly<Record<string, unknown>>) =>
      code.harness.engine.call(codeCaller(), codeInvocation('code_read', 'widgets', toolArguments));
    expect(resultOf(await read({ file_path: 'src/widget.ts' }))).toStrictEqual({
      repo: 'widgets',
      commit: SHA.main,
      file_path: 'src/widget.ts',
      start_line: 1,
      end_line: 2,
      total_lines: 5,
      text: 'one\ntwo',
      truncated: true,
      duration_ms: 0,
    });
    const range = resultOf(await read({ file_path: 'src/widget.ts', start_line: 4, end_line: 5 }));
    expect([range['text'], range['truncated']]).toStrictEqual(['four\nfive', false]);
    expect(code.sidecar.queries.at(-1)?.body).toMatchObject({
      start_line: 4,
      end_line: 5,
      max_lines: 2,
    });
  });

  it('ACT-111 a path the snapshot does not hold is path_not_found, a NUL is not_text and a range past the end invalid_arguments', async () => {
    const files = { 'bin/tool': 'MZ\0\0binary', 'a.txt': 'one' };
    const code = createCodeHarness({ sidecar: { files } });
    await createCodeTarget(code);
    const codes = [];
    for (const toolArguments of [
      { file_path: '.env' },
      { file_path: 'bin/tool' },
      { file_path: 'a.txt', start_line: 9 },
    ]) {
      const outcome = await code.harness.engine.call(
        codeCaller(),
        codeInvocation('code_read', 'widgets', toolArguments),
      );
      codes.push(
        outcome.kind === 'error' ? [outcome.error.code, outcome.error.detail] : outcome.kind,
      );
    }
    expect(codes).toStrictEqual([
      ['path_not_found', undefined],
      ['not_text', undefined],
      ['invalid_arguments', { problem: 'invalid_range' }],
    ]);
  });
});

describe('the output cap (ACT-52)', () => {
  it('ACT-52 a search answer past max_output_bytes loses whole results from the end, with truncated: true', async () => {
    const answer = () =>
      Array.from({ length: 20 }, (_value, index) =>
        sidecarResult('widgets', {
          file_path: `src/f${String(index)}.ts`,
          content: 'x'.repeat(200),
        }),
      );
    const code = createCodeHarness({ sidecar: { answer } });
    await createCodeTarget(code, { policy: { max_output_bytes: 2048 } });
    const result = resultOf(
      await code.harness.engine.call(codeCaller(), search('widgets', { top_k: 20 })),
    );
    const kept = result['results'] as { file_path: string }[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    expect(kept.map((entry) => entry.file_path)).toStrictEqual(
      Array.from({ length: kept.length }, (_value, index) => `src/f${String(index)}.ts`),
    );
    expect(result['truncated']).toBe(true);
    const { duration_ms: _duration, truncated: _truncated, ...answered } = result;
    expect(Buffer.byteLength(JSON.stringify(answered))).toBeLessThanOrEqual(2048);
    expect(storedCalls(code.harness.database).at(-1)?.outputTruncated).toBe(true);
  });

  it("ACT-52 a read's text is cut at max_output_bytes, with truncated: true", async () => {
    const code = createCodeHarness({ sidecar: { files: { 'big.txt': 'y'.repeat(5000) } } });
    await createCodeTarget(code, { policy: { max_output_bytes: 1024 } });
    const result = resultOf(
      await code.harness.engine.call(
        codeCaller(),
        codeInvocation('code_read', 'widgets', { file_path: 'big.txt' }),
      ),
    );
    expect([(result['text'] as string).length, result['truncated']]).toStrictEqual([1024, true]);
  });
});
