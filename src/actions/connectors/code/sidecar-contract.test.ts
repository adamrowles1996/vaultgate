import { describe, expect, it } from 'vitest';

import { resultOf } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  codeInvocation,
  createCodeHarness,
  createCodeTarget,
  search,
} from '../../../test-support/code-connector.ts';

import type { Route, Script } from '../../../test-support/fake-code-sidecar.ts';

function refusalBody(error: string, detail?: Readonly<Record<string, unknown>>): Script {
  const body = { error, message: `the sidecar says ${error}`, ...(detail && { detail }) };
  return {
    status: error === 'internal_error' ? 500 : 422,
    body: Buffer.from(JSON.stringify(body)),
  };
}

function read(code: ReturnType<typeof createCodeHarness>, toolArguments: Record<string, unknown>) {
  return code.harness.engine.call(
    codeCaller(),
    codeInvocation('code_read', 'widgets', toolArguments),
  );
}

describe('what the real sidecar answers (PROTOCOL.md)', () => {
  it('ACT-110 related with a seed chunk but nothing related answers an empty result list, not an error', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [] } });
    await createCodeTarget(code);
    const outcome = await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', { file_path: 'src/widget.ts', line: 3 }),
    );
    expect([resultOf(outcome)['results'], resultOf(outcome)['truncated']]).toStrictEqual([
      [],
      false,
    ]);
  });

  it("ACT-110 code_read counts lines as Python's splitlines: CRLF, CR and the other breaks end a line, a final break adds none", async () => {
    const files = {
      'crlf.txt': 'one\r\ntwo\r\n',
      'mixed.txt': 'a\rb c\fd\ve\u{85}f\n',
      'empty.txt': '',
    };
    const code = createCodeHarness({ sidecar: { files } });
    await createCodeTarget(code);
    const crlf = resultOf(await read(code, { file_path: 'crlf.txt' }));
    const mixed = resultOf(await read(code, { file_path: 'mixed.txt' }));
    const empty = resultOf(await read(code, { file_path: 'empty.txt' }));
    expect([crlf['text'], crlf['total_lines']]).toStrictEqual(['one\ntwo', 2]);
    expect([mixed['text'], mixed['total_lines']]).toStrictEqual(['a\nb\nc\nd\ne\nf', 6]);
    expect([empty['start_line'], empty['end_line'], empty['text']]).toStrictEqual([1, 0, '']);
  });

  it('ACT-111 a read range that runs backwards is invalid_arguments before any request; past the end the sidecar refuses it', async () => {
    const code = createCodeHarness({ sidecar: { files: { 'a.txt': 'one\ntwo' } } });
    await createCodeTarget(code);
    const before = code.sidecar.requests.length;
    const backwards = await read(code, { file_path: 'a.txt', start_line: 3, end_line: 2 });
    expect(
      backwards.kind === 'error' && [backwards.error.code, backwards.error.detail],
    ).toStrictEqual([
      'invalid_arguments',
      { problems: 'end_line: must not be before start_line', repo: 'widgets' },
    ]);
    expect(code.sidecar.requests).toHaveLength(before);
    const past = await read(code, { file_path: 'a.txt', start_line: 3 });
    expect(past.kind === 'error' && past.error.detail).toStrictEqual({ problem: 'invalid_range' });
  });

  it('ACT-74 ACT-113 the general errors (not_found, method_not_allowed, internal_error) are a connector fault naming the code only', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    const scripts: [Route, Script][] = [
      [
        'search',
        { status: 404, body: Buffer.from('{"error":"not_found","message":"no such operation"}') },
      ],
      [
        'search',
        {
          status: 405,
          body: Buffer.from('{"error":"method_not_allowed","message":"allowed: POST"}'),
        },
      ],
      ['search', refusalBody('internal_error')],
    ];
    const details = [];
    for (const [route, script] of scripts) {
      code.sidecar.script(route, script);
      const outcome = await code.harness.engine.call(codeCaller(), search('widgets'));
      details.push(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]);
    }
    expect(details).toStrictEqual(
      ['not_found', 'method_not_allowed', 'internal_error'].map((reason) => [
        'connector_fault',
        { reason: 'sidecar', message: reason },
      ]),
    );
  });

  it('ACT-112 a variant that fails to build on a search is index_not_ready failed with the code, never the counts', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    code.sidecar.script(
      'search',
      refusalBody('build_failed', {
        members: 9,
        files: 3,
        bytes: 90,
        skipped: {},
        variant: 'docs',
      }),
    );
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search('widgets', { content: 'docs' }),
    );
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'index_not_ready',
      { state: 'failed', repo: 'widgets', reason: 'build_failed' },
    ]);
  });
});
