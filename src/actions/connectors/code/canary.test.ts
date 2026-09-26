import { describe, expect, it } from 'vitest';

import { fail } from '../../../result.ts';
import {
  codeCaller,
  codeInvocation,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
  type CodeHarness,
} from '../../../test-support/code-connector.ts';
import { FAKE_ARCHIVE_TOKEN } from '../../../test-support/fake-github.ts';
import { surfaces } from '../../../test-support/http-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { ActionError } from '../../errors.ts';
import { scrubVariants } from '../../scrub.ts';

import type { FakeQuery } from '../../../test-support/fake-code-sidecar.ts';
import type { CallOutcome } from '../../engine-context.ts';
import type { Invocation } from '../../engine-resolve.ts';
import type { InjectedValues } from '../../scrub.ts';

const HIDDEN_FIELD = 'custom.API key';

/**
Every encoding of both tokens, and the archive redirect's own token, that must appear nowhere.
*/
function leaked(everything: string): readonly string[] {
  const forbidden = [
    ...scrubVariants(CANARY.password),
    ...scrubVariants(CANARY.hiddenField),
    ...scrubVariants(FAKE_ARCHIVE_TOKEN),
  ];
  return forbidden.filter((variant) => everything.includes(variant));
}

/**
 * Text a hostile repository could hold: its own connection's token, raw and
 * encoded; the gadgets repository also holds the widgets token, which a
 * search over both must redact with the widgets table.
 */
const HOSTILE: Readonly<Record<string, string>> = {
  widgets: [
    CANARY.password,
    encodeURIComponent(CANARY.password),
    JSON.stringify(CANARY.password),
  ].join(' '),
  gadgets: [
    CANARY.hiddenField,
    Buffer.from(CANARY.hiddenField).toString('base64'),
    CANARY.password,
  ].join(' '),
};

function hostileAnswer(query: FakeQuery) {
  const indexes = query.body['indexes'] as readonly { readonly label: string }[];
  return indexes.map(({ label }) =>
    sidecarResult(label, { content: HOSTILE[label], file_path: `src/${HOSTILE[label] ?? ''}.ts` }),
  );
}

function hostileHarness(options: { readonly echo: boolean }): CodeHarness {
  return createCodeHarness({
    github: {
      echo: options.echo,
      repos: [
        fakeRepo(),
        fakeRepo({ fullName: OTHER_REPO, isPrivate: false, refs: { main: SHA.other } }),
      ],
    },
    sidecar: {
      answer: hostileAnswer,
      files: { 'leak.txt': `token=${HOSTILE['widgets'] ?? ''}` },
    },
  });
}

async function targets(code: CodeHarness): Promise<void> {
  await createCodeTarget(code);
  await createCodeTarget(code, {
    name: 'gadgets',
    destination: { repository: OTHER_REPO },
    mapping: { token_field: HIDDEN_FIELD },
  });
}

async function callAll(
  code: CodeHarness,
  invocations: readonly Invocation[],
): Promise<CallOutcome[]> {
  const outcomes: CallOutcome[] = [];
  for (const invocation of invocations) {
    outcomes.push(await code.harness.engine.call(codeCaller(), invocation));
  }
  return outcomes;
}

const EVERY_TOOL: readonly Invocation[] = [
  search('widgets'),
  search(['widgets', 'gadgets']),
  search('widgets', { ref: 'v1.0' }),
  codeInvocation('code_find_related', ['widgets', 'gadgets'], {
    file_path: 'widgets/src/a.ts',
    line: 2,
  }),
  codeInvocation('code_read', 'widgets', { file_path: 'leak.txt' }),
  codeInvocation('code_read', 'gadgets', { file_path: 'missing.txt' }),
];

describe('the ACT-53 canary over the code connector', () => {
  it('ACT-53 ACT-51 no token, and no archive redirect token, reaches a result, a row, an audit event or a log line, when the repository holds them', async () => {
    const code = hostileHarness({ echo: false });
    await targets(code);
    const outcomes = await callAll(code, EVERY_TOOL);
    expect(outcomes.map((outcome) => outcome.kind)).toStrictEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'error',
    ]);
    const everything = surfaces(code.harness, [
      outcomes,
      await code.harness.engine.code?.status('id-1'),
    ]);
    expect(leaked(everything)).toStrictEqual([]);
    expect(everything).toContain('[redacted:password]');
    expect(everything).toContain('[redacted:custom.API key]');
  });

  it('ACT-53 ACT-104 when GitHub echoes the Authorization header as a branch name and in the redirect, nothing carries the token', async () => {
    const code = hostileHarness({ echo: true });
    await targets(code);
    const outcomes = await callAll(code, EVERY_TOOL);
    const status = await code.harness.engine.code?.status('id-1');
    expect(status?.resolution).toMatchObject({ ref: 'Bearer [redacted:password]' });
    const everything = surfaces(code.harness, [
      outcomes,
      status,
      code.harness.engine.listTargets(codeCaller()),
    ]);
    expect(leaked(everything)).toStrictEqual([]);
  });

  it('ACT-53 ACT-74 failures carry no token either: GitHub refusals, sidecar refusals, an unreachable sidecar and timeouts', async () => {
    const code = hostileHarness({ echo: true });
    await targets(code);
    code.github.requests.length = 0;
    const failing = createCodeHarness({
      github: {
        answer: () =>
          Response.json({ message: `bad credentials ${CANARY.password}` }, { status: 500 }),
      },
    });
    await createCodeTarget(failing);
    code.sidecar.script('search', {
      status: 422,
      body: Buffer.from(`{"error":"build_failed","message":"${CANARY.password}"}`),
    });
    code.sidecar.script('read', {
      status: 500,
      body: Buffer.from(`{"error":"${CANARY.password}"}`),
    });
    const outcomes = [
      ...(await callAll(code, [
        search('widgets'),
        codeInvocation('code_read', 'widgets', { file_path: 'leak.txt' }),
      ])),
      ...(await callAll(failing, [search('widgets'), search('widgets', { ref: 'v1.0' })])),
    ];
    code.sidecar.unreachable(true);
    outcomes.push(...(await callAll(code, [search('widgets', { ref: 'v1.0' })])));
    expect(outcomes.map((outcome) => outcome.kind === 'error' && outcome.error.code)).toStrictEqual(
      [
        'index_not_ready',
        'connector_fault',
        'upstream_error',
        'upstream_error',
        'index_unavailable',
      ],
    );
    const everything = [surfaces(code.harness, [outcomes]), surfaces(failing.harness, [])].join(
      '\n',
    );
    expect(leaked(everything)).toStrictEqual([]);
  });

  it('ACT-50 every token buffer of a call over several repositories is zeroed when the call ends', async () => {
    const code = hostileHarness({ echo: false });
    await targets(code);
    const lent: InjectedValues[] = [];
    const { connector } = code;
    const original = connector.runMany?.bind(connector);
    connector.runMany = async (contexts, operation) => {
      lent.push(...contexts.map((context) => context.injected));
      return original === undefined
        ? fail(new ActionError('connector_fault'))
        : original(contexts, operation);
    };
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(outcome.kind).toBe('ok');
    const buffers = [lent[0]?.value('password'), lent[1]?.value(HIDDEN_FIELD)];
    expect(buffers.map((buffer) => buffer?.length)).toStrictEqual([
      CANARY.password.length,
      CANARY.hiddenField.length,
    ]);
    expect(buffers.every((buffer) => buffer?.every((byte) => byte === 0))).toBe(true);
  });
});
