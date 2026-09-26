import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
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

import type { FakeQuery } from '../../../test-support/fake-code-sidecar.ts';

const FILES = {
  'src/widget.ts': 'export function makeWidget() {}\n',
  'widgets/notes.md': '# Notes\n',
};

/**
One result per index; the fake sidecar prefixes merged results with their label, as `semble` does.
*/
function merged(query: FakeQuery): readonly Record<string, unknown>[] {
  const indexes = query.body['indexes'] as readonly { readonly label: string }[];
  return indexes.map((index) => sidecarResult(index.label));
}

function harness() {
  return createCodeHarness({ sidecar: { answer: merged, files: FILES } });
}

function read(code: ReturnType<typeof harness>, repo: string, filePath: string) {
  return code.harness.engine.call(
    codeCaller(),
    codeInvocation('code_read', repo, { file_path: filePath }),
  );
}

function readPaths(code: ReturnType<typeof harness>): readonly unknown[] {
  return code.sidecar.requests.filter((request) => request.path === '/v1/read');
}

describe('code_read after a search over several repositories (ACT-110, ACT-111)', () => {
  it('ACT-111 reads a file_path a several-repo search gave, dropping its own connection’s prefix', async () => {
    const code = harness();
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    const found = resultOf(
      await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets'])),
    );
    const [first] = found['results'] as readonly {
      readonly repo: string;
      readonly file_path: string;
    }[];
    expect(first).toMatchObject({ repo: 'widgets', file_path: 'widgets/src/widget.ts' });
    const outcome = await read(code, first?.repo ?? '', first?.file_path ?? '');
    expect(resultOf(outcome)).toMatchObject({
      repo: 'widgets',
      file_path: 'src/widget.ts',
      text: 'export function makeWidget() {}',
    });
    expect(readPaths(code)).toHaveLength(2);
  });

  it('ACT-111 a path the snapshot holds as given is read as given, and another connection’s prefix is not dropped', async () => {
    const code = harness();
    await createCodeTarget(code);
    const notes = await read(code, 'widgets', 'widgets/notes.md');
    expect(resultOf(notes)).toMatchObject({ file_path: 'widgets/notes.md', text: '# Notes' });
    expect(readPaths(code)).toHaveLength(1);
    const other = await read(code, 'widgets', 'gadgets/src/widget.ts');
    expect(other.kind === 'error' && other.error.code).toBe('path_not_found');
    const neither = await read(code, 'widgets', 'widgets/src/missing.ts');
    expect(neither.kind === 'error' && neither.error.code).toBe('path_not_found');
    expect(readPaths(code)).toHaveLength(4);
  });

  it('ACT-110 code_read’s description says a prefixed file_path may be passed as it is', () => {
    const tool = CODE_TOOLS.find((candidate) => candidate.name === 'code_read');
    expect(tool?.description).toContain(
      'A file_path from a search over several repositories begins with the connection name: pass it as it is',
    );
  });
});
