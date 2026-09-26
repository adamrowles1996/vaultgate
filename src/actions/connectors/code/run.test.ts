import { describe, expect, it } from 'vitest';

import { fail, ok, type Result } from '../../../result.ts';
import { captureLogger } from '../../../test-support/logging.ts';
import { ManualClock } from '../../../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { recordedSupport } from '../../../test-support/run-support.ts';
import { ActionError } from '../../errors.ts';

import { runCode } from './run.ts';
import { codeCredentialSchema, codeDestinationSchema, codePolicySchema } from './schemas.ts';
import { SidecarRefusal, type SidecarClient, type SidecarOutcome } from './sidecar.ts';

import type { RunContext } from '../connector.ts';
import type { Indexes, Prepared } from './indexes.ts';
import type { SidecarResult } from './sidecar-schemas.ts';

type Context = RunContext<unknown, unknown, unknown>;

function context(
  name: string,
  policy: Readonly<Record<string, unknown>> = {},
  tool = 'code_search',
): Context {
  const parsed = codePolicySchema.parse(policy);
  const { logger } = captureLogger();
  return {
    destination: codeDestinationSchema.parse({ repository: `acme/${name}` }),
    credential: codeCredentialSchema.parse({}),
    policy: parsed,
    common: parsed,
    tool,
    injected: recordedSupport().secrets.injected,
    support: recordedSupport({ target: { id: `id-${name}`, name } }).support,
    pinned: [],
    signal: new AbortController().signal,
    outputLimit: { maxBytes: parsed.max_output_bytes, guardBytes: 0 },
    logger,
  };
}

function prepared(name: string): Prepared {
  return {
    targetId: `id-${name}`,
    key: `id-${name}.0123456789abcdef.${'a'.repeat(40)}`,
    label: name,
    repository: `acme/${name}`,
    commit: 'a'.repeat(40),
    ref: 'main',
    stale: false,
    indexedAt: 1,
  };
}

interface Stubs {
  readonly indexes: Indexes & { readonly forgotten: string[]; readonly prepares: string[] };
  readonly sidecar: SidecarClient;
}

type SearchAnswer = SidecarOutcome<SidecarResult[]> | 'hang';

function stubs(answers: SearchAnswer[], failing?: Readonly<Record<string, ActionError>>): Stubs {
  const forgotten: string[] = [];
  const prepares: string[] = [];
  const indexes = {
    forgotten,
    prepares,
    prepare: (
      request: Parameters<Indexes['prepare']>[0],
    ): Promise<Result<Prepared, ActionError>> => {
      const { name } = request.context.support.target;
      prepares.push(name);
      const error = failing?.[name];
      return Promise.resolve(error === undefined ? ok(prepared(name)) : fail(error));
    },
    forget: (targetId: string, key: string) => {
      forgotten.push(`${targetId} ${key}`);
    },
  };
  const sidecar: SidecarClient = {
    health: unused,
    build: unused,
    status: unused,
    list: unused,
    deleteSnapshot: unused,
    deleteOwner: unused,
    related: unused,
    read: unused,
    search: (_query, signal) => {
      const next = answers.shift() ?? ok([]);
      if (next !== 'hang') {
        return Promise.resolve(next);
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(fail(new ActionError('timeout')));
        });
      });
    },
  };
  return { indexes, sidecar };
}

function unused(): never {
  throw new Error('not in this test');
}

const SEARCH = { query: 'widgets', top_k: 5, max_snippet_lines: 10 } as const;
const MISSING = fail(new SidecarRefusal('snapshot_missing'));

describe('one code call over its repositories (ACT-110, ACT-112)', () => {
  it('ACT-112 a snapshot the sidecar has since evicted is forgotten and prepared once more', async () => {
    const { indexes, sidecar } = stubs([MISSING, ok([])]);
    const result = unwrapOk(
      await runCode(
        { sidecar, indexes, clock: new ManualClock() },
        [context('a'), context('b')],
        SEARCH,
      ),
    );
    expect(result.result['results']).toStrictEqual([]);
    expect(indexes.prepares).toStrictEqual(['a', 'b', 'a', 'b']);
    expect(indexes.forgotten).toStrictEqual([
      `id-a ${prepared('a').key}`,
      `id-b ${prepared('b').key}`,
    ]);
  });

  it('ACT-113 a snapshot evicted twice in one call is index_unavailable', async () => {
    const { indexes, sidecar } = stubs([MISSING, MISSING]);
    const error = unwrapFail(
      await runCode({ sidecar, indexes, clock: new ManualClock() }, [context('a')], SEARCH),
    );
    expect(error.code).toBe('index_unavailable');
    expect(indexes.prepares).toStrictEqual(['a', 'a']);
  });

  it('ACT-112 a query still waiting for its variant when the wait and the grace are over is index_not_ready building', async () => {
    const clock = new ManualClock();
    const { indexes, sidecar } = stubs(['hang']);
    const pending = runCode(
      { sidecar, indexes, clock },
      [context('a', { build_wait_s: 5 }), context('b')],
      SEARCH,
    );
    await clock.advance(5000 + 7999);
    let isSettled = false;
    void pending.then(() => {
      isSettled = true;
    });
    await clock.settle();
    expect(isSettled).toBe(false);
    await clock.advance(1);
    const error = unwrapFail(await pending);
    expect([error.code, error.detail]).toStrictEqual([
      'index_not_ready',
      { state: 'building', repo: 'a,b' },
    ]);
  });

  it('ACT-110 ACT-112 the first repository that cannot be prepared ends the call with its error, naming it', async () => {
    const refused = new ActionError('ref_not_found');
    const { indexes, sidecar } = stubs([], { b: refused });
    const error = unwrapFail(
      await runCode(
        { sidecar, indexes, clock: new ManualClock() },
        [context('a'), context('b'), context('c')],
        SEARCH,
      ),
    );
    expect([error.code, error.detail]).toStrictEqual(['ref_not_found', { repo: 'b' }]);
    expect(indexes.prepares).toStrictEqual(['a', 'b', 'c']);
    const alone = await runCode(
      { sidecar, indexes, clock: new ManualClock() },
      [context('b')],
      SEARCH,
    );
    expect(unwrapFail(alone)).toBe(refused);
  });

  it('ACT-110 without the engine too, a selection no repository shares is refused before anything is prepared', async () => {
    const { indexes, sidecar } = stubs([]);
    const contexts: [Context, Context] = [
      context('a', { content: ['docs'] }),
      context('b', { content: ['code'] }),
    ];
    const error = unwrapFail(
      await runCode({ sidecar, indexes, clock: new ManualClock() }, contexts, SEARCH),
    );
    expect([error.code, error.detail]).toStrictEqual(['policy_denied', { reason: 'content' }]);
    const documentation = { ...SEARCH, content: 'docs' } as const;
    const single = unwrapFail(
      await runCode({ sidecar, indexes, clock: new ManualClock() }, contexts, documentation),
    );
    expect(single.detail).toStrictEqual({ reason: 'content' });
    expect(indexes.prepares).toStrictEqual([]);
  });

  it('ACT-110 without the engine too, code_read over several repositories is refused', async () => {
    const { indexes, sidecar } = stubs([]);
    const contexts: [Context, Context] = [
      context('a', {}, 'code_read'),
      context('b', {}, 'code_read'),
    ];
    const error = unwrapFail(
      await runCode({ sidecar, indexes, clock: new ManualClock() }, contexts, {
        file_path: 'a.ts',
      }),
    );
    expect([error.code, error.detail]).toStrictEqual([
      'invalid_arguments',
      { problem: 'code_read takes one repo' },
    ]);
  });
});
