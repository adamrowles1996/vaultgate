import { describe, expect, it } from 'vitest';

import { storedCalls } from '../../../test-support/actions-fixtures.ts';
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

import type { AuditEvent } from '../../../audit/event.ts';

function buildEvents(audit: readonly AuditEvent[]): readonly AuditEvent[] {
  return audit.filter((event) => event.action.startsWith('code_index_'));
}

describe('the call trail of the code tools (ACT-60, ACT-116)', () => {
  it('ACT-116 ACT-60 a search over two repositories leaves one row per repository, operation read, classification search, with the arguments', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets'], { top_k: 3 }));
    const rows = storedCalls(code.harness.database).map((row) => ({
      target: row.targetName,
      connector: row.connector,
      tool: row.tool,
      operation: row.operation,
      classification: row.classification,
      arguments: JSON.parse(row.arguments) as unknown,
      outcome: row.outcome,
    }));
    const recorded = { repo: ['widgets', 'gadgets'], query: 'where are widgets made', top_k: 3 };
    expect(rows).toStrictEqual([
      {
        target: 'widgets',
        connector: 'code',
        tool: 'code_search',
        operation: 'read',
        classification: 'search',
        arguments: recorded,
        outcome: 'ok',
      },
      {
        target: 'gadgets',
        connector: 'code',
        tool: 'code_search',
        operation: 'read',
        classification: 'search',
        arguments: recorded,
        outcome: 'ok',
      },
    ]);
    const events = code.harness.audit.filter((event) => event.category === 'mcp');
    expect(
      events.map((event) => [event.action, event.details?.['target'], event.outcome]),
    ).toStrictEqual([
      ['code_search', 'widgets', 'ok'],
      ['code_search', 'gadgets', 'ok'],
    ]);
  });

  it('ACT-116 find_related is classified related and code_read read, with the path and the lines recorded', async () => {
    const code = createCodeHarness({
      sidecar: { answer: () => [sidecarResult('widgets')], files: { 'src/widget.ts': 'a\nb\nc' } },
    });
    await createCodeTarget(code);
    await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_find_related', 'widgets', { file_path: 'src/widget.ts', line: 2 }),
    );
    await code.harness.engine.call(
      codeCaller(),
      codeInvocation('code_read', 'widgets', {
        file_path: 'src/widget.ts',
        start_line: 2,
        end_line: 3,
      }),
    );
    expect(
      storedCalls(code.harness.database).map((row) => [
        row.classification,
        JSON.parse(row.arguments) as unknown,
      ]),
    ).toStrictEqual([
      ['related', { repo: 'widgets', file_path: 'src/widget.ts', line: 2 }],
      ['read', { repo: 'widgets', file_path: 'src/widget.ts', start_line: 2, end_line: 3 }],
    ]);
  });

  it('ACT-61 ACT-116 a refused call is recorded with the reason, and its arguments are never the result', async () => {
    const code = createCodeHarness({
      sidecar: { answer: () => [sidecarResult('widgets', { content: 'RESULT-TEXT' })] },
    });
    await createCodeTarget(code, { policy: { allow_ref: false } });
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    await code.harness.engine.call(codeCaller(), search('widgets'));
    const rows = storedCalls(code.harness.database);
    expect(rows.map((row) => [row.outcome, row.classification])).toStrictEqual([
      ['denied:policy_denied', 'search'],
      ['ok', 'search'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('RESULT-TEXT');
  });
});

describe('build events (ACT-116)', () => {
  it('ACT-116 a build is code_index_built with the target, commit, content, trigger, counts and duration, and nothing else', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    expect(buildEvents(code.harness.audit)).toStrictEqual([
      {
        category: 'actions',
        action: 'code_index_built',
        outcome: 'ok',
        durationMs: 0,
        details: {
          target: 'widgets',
          connector: 'code',
          commit: SHA.main,
          trigger: 'save',
          content: ['code+docs+config'],
          files: 3,
          chunks: 7,
          skipped: 3,
        },
      },
    ]);
  });

  it('ACT-116 a failed build is code_index_failed with the reason code, and a call-triggered build says so', async () => {
    const code = createCodeHarness();
    code.sidecar.script('build', {
      status: 422,
      body: Buffer.from('{"error":"archive_invalid","message":"no top-level directory"}'),
    });
    await createCodeTarget(code, { policy: { content: ['docs'] } });
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: 'v1.0' }));
    expect(
      buildEvents(code.harness.audit).map((event) => [event.action, event.outcome, event.details]),
    ).toStrictEqual([
      [
        'code_index_failed',
        'error:archive_invalid',
        {
          target: 'widgets',
          connector: 'code',
          commit: SHA.main,
          trigger: 'save',
          content: ['docs'],
          reason: 'archive_invalid',
        },
      ],
      [
        'code_index_built',
        'ok',
        {
          target: 'widgets',
          connector: 'code',
          commit: SHA.tag,
          trigger: 'call',
          content: ['docs'],
          files: 3,
          chunks: 7,
          skipped: 3,
        },
      ],
    ]);
  });

  it('ACT-116 a build that cannot start is recorded as code_index_failed without a commit', async () => {
    const code = createCodeHarness({
      github: { answer: () => new Response(null, { status: 404 }) },
    });
    await createCodeTarget(code);
    expect(
      buildEvents(code.harness.audit).map((event) => [event.outcome, event.details]),
    ).toStrictEqual([
      [
        'error:ref_not_found',
        {
          target: 'widgets',
          connector: 'code',
          trigger: 'save',
          content: ['code+docs+config'],
          reason: 'ref_not_found',
        },
      ],
    ]);
  });
});

describe('actions_list_targets for a code target (ACT-19, ACT-112)', () => {
  it('ACT-19 ACT-112 reports the repository, the configured ref, the content it allows and whether code_read is', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO, ref: 'main' },
      policy: { content: ['config', 'docs'], allow_read: false },
    });
    expect(code.harness.engine.listTargets(codeCaller())).toStrictEqual([
      {
        name: 'gadgets',
        description: 'The widgets repository',
        connector: 'code',
        operations: ['read'],
        confirm_writes: false,
        repository: 'acme/gadgets',
        ref: 'main',
        content: ['docs', 'config'],
        read: false,
      },
      {
        name: 'widgets',
        description: 'The widgets repository',
        connector: 'code',
        operations: ['read'],
        confirm_writes: false,
        repository: 'acme/widgets',
        content: ['code', 'docs', 'config'],
        read: true,
      },
    ]);
    expect(code.harness.engine.listTargets(codeCaller({ scopes: ['actions:http'] }))).toStrictEqual(
      [],
    );
  });
});
