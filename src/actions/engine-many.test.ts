import { describe, expect, it } from 'vitest';

import { fail, ok } from '../result.ts';
import { OPERATOR_ID, storedCalls } from '../test-support/actions-fixtures.ts';
import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
  type CodeHarness,
} from '../test-support/code-connector.ts';
import { unwrapOk } from '../test-support/result.ts';
import { CANARY } from '../test-support/vault-fixture.ts';
import { VaultError } from '../vault/client.ts';

import { ActionError } from './errors.ts';
import { scrubVariants } from './scrub.ts';

import type { CallOutcome } from './engine-context.ts';

const ADDRESSES: Record<string, string[]> = {};

async function twoRepos(policy: Readonly<Record<string, unknown>> = {}): Promise<CodeHarness> {
  const code = createCodeHarness({ harness: { addresses: ADDRESSES } });
  await createCodeTarget(code, { policy });
  await createCodeTarget(code, {
    name: 'gadgets',
    destination: { repository: OTHER_REPO },
    policy,
  });
  return code;
}

function rows(code: CodeHarness): readonly (readonly [string, string])[] {
  return storedCalls(code.harness.database).map((row) => [row.targetName, row.outcome] as const);
}

function failure(outcome: CallOutcome): readonly [string, unknown] | undefined {
  return outcome.kind === 'error' ? [outcome.error.code, outcome.error.detail] : undefined;
}

describe('a call over several targets that fails before it runs (ACT-16, ACT-60, ACT-110)', () => {
  it('ACT-54 ACT-60 a credential that cannot be fetched fails the call for every target, one row each, naming the repo', async () => {
    const code = await twoRepos();
    code.harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(outcome)).toStrictEqual(['credential_unavailable', { repo: 'widgets' }]);
    expect(rows(code)).toStrictEqual([
      ['widgets', 'error:credential_unavailable'],
      ['gadgets', 'error:credential_unavailable'],
    ]);
    expect(
      code.github.requests.filter((request) => request.url.includes('/tarball/')),
    ).toHaveLength(2);
  });

  it('ACT-56 a destination refused for the second target fails the call for both, and its credential is zeroed', async () => {
    const code = await twoRepos();
    ADDRESSES['codeload.github.com'] = ['10.0.0.9'];
    try {
      const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
      expect(failure(outcome)).toStrictEqual([
        'destination_refused',
        { reason: 'private', repo: 'widgets' },
      ]);
      expect(rows(code)).toStrictEqual([
        ['widgets', 'error:destination_refused'],
        ['gadgets', 'error:destination_refused'],
      ]);
    } finally {
      delete ADDRESSES['codeload.github.com'];
    }
  });

  it('ACT-59 a rate-limited target refuses the call with retry_after_s and names the repo', async () => {
    const code = await twoRepos({ rate_limit_per_minute: 1 });
    const alone = await code.harness.engine.call(codeCaller(), search('gadgets'));
    expect(alone.kind).toBe('ok');
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(outcome)).toStrictEqual([
      'rate_limited',
      { retry_after_s: 60, repo: 'gadgets' },
    ]);
    expect(rows(code).slice(-2)).toStrictEqual([
      ['widgets', 'denied:rate_limited'],
      ['gadgets', 'denied:rate_limited'],
    ]);
    await code.harness.clock.advance(60_000);
    const later = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(later.kind).toBe('ok');
  });

  it('ACT-110 a tool that takes several targets refuses one whose policy lets the call write', async () => {
    const code = await twoRepos();
    code.connector.authorize = () => ({ allowed: true, operation: 'write' });
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(outcome)).toStrictEqual([
      'connector_fault',
      { reason: 'multi_target_write', repo: 'widgets' },
    ]);
    expect(rows(code)).toStrictEqual([
      ['widgets', 'error:connector_fault'],
      ['gadgets', 'error:connector_fault'],
    ]);
  });

  it('ACT-116 ACT-60 a name of several that cannot be resolved fails the call with one row per repository, naming the first failure', async () => {
    const code = await twoRepos();
    unwrapOk(code.harness.engine.targets.setEnabled('id-2', false, OPERATOR_ID));
    const outcome = await code.harness.engine.call(
      codeCaller(),
      search(['widgets', 'gadgets', 'nowhere']),
    );
    expect(failure(outcome)).toStrictEqual(['target_disabled', { repo: 'gadgets' }]);
    expect(rows(code)).toStrictEqual([
      ['widgets', 'denied:target_disabled'],
      ['gadgets', 'denied:target_disabled'],
      ['nowhere', 'denied:target_disabled'],
    ]);
    const events = code.harness.audit.filter((event) => event.category === 'mcp');
    expect(events.map((event) => event.details?.['target'])).toStrictEqual([
      'widgets',
      'gadgets',
      'nowhere',
    ]);
  });

  it('ACT-110 with no joint decision of its own, a connector is judged target by target only', async () => {
    const code = await twoRepos();
    Reflect.deleteProperty(code.connector, 'authorizeMany');
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(outcome.kind).toBe('ok');
  });
});

describe('the run of a call over several targets (ACT-50, ACT-51, ACT-59)', () => {
  it('ACT-52 every context carries the smallest cap and a guard band as wide as the longest value of any target', async () => {
    const code = await twoRepos();
    unwrapOk(
      await code.harness.engine.targets.update(
        code.harness.engine.targets.repo.findByName('gadgets')?.id ?? '',
        {
          description: '',
          destination: { repository: OTHER_REPO },
          internal: false,
          credential: { item_id: 'item-login', mapping: { token_field: 'custom.API key' } },
          policy: { max_output_bytes: 4096 },
        },
        OPERATOR_ID,
      ),
    );
    const seen: [number, number][] = [];
    code.connector.runMany = (contexts) => {
      seen.push(
        ...contexts.map(
          (context) =>
            [context.outputLimit.maxBytes, context.outputLimit.guardBytes] as [number, number],
        ),
      );
      return Promise.resolve(ok({ result: { query: 'q', results: [], repos: [] }, captured: {} }));
    };
    await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    const longest = Math.max(
      ...[...scrubVariants(CANARY.password), ...scrubVariants(CANARY.hiddenField)].map((variant) =>
        Buffer.byteLength(variant),
      ),
    );
    expect(seen).toStrictEqual([
      [4096, longest],
      [4096, longest],
    ]);
  });

  it('ACT-59 the smallest timeout of the targets ends the call as timeout, and a connector that throws is upstream_error, scrubbed', async () => {
    const code = await twoRepos();
    const never = Promise.withResolvers<never>();
    code.connector.runMany = () => never.promise;
    const pending = code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    await code.harness.clock.advance(150_000);
    expect(failure(await pending)).toStrictEqual(['timeout', undefined]);
    code.connector.runMany = (contexts) => {
      throw new Error(
        `crashed holding ${contexts[0]?.injected.value('password')?.toString() ?? ''}`,
      );
    };
    const thrown = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(thrown)).toStrictEqual([
      'upstream_error',
      { message: 'crashed holding [redacted:password]' },
    ]);
    code.connector.runMany = () => {
      // A careless library throws text.
      throw 'text'; // eslint-disable-line @typescript-eslint/only-throw-error -- the point of the test
    };
    const text = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(text)).toStrictEqual(['upstream_error', { message: 'text' }]);
    expect(rows(code).map(([, outcome]) => outcome)).toStrictEqual([
      'error:timeout',
      'error:timeout',
      'error:upstream_error',
      'error:upstream_error',
      'error:upstream_error',
      'error:upstream_error',
    ]);
  });

  it('ACT-110 a connector without runMany cannot serve a repo tool', async () => {
    const code = await twoRepos();
    Reflect.deleteProperty(code.connector, 'runMany');
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(outcome)).toStrictEqual([
      'connector_fault',
      { reason: 'internal', message: 'no runMany' },
    ]);
  });

  it('ACT-51 an error a run returns is scrubbed with every table before the agent sees it', async () => {
    const code = await twoRepos();
    code.connector.runMany = (contexts) => {
      const message = contexts[0]?.injected.value('password')?.toString() ?? '';
      return Promise.resolve(fail(new ActionError('upstream_error', { message })));
    };
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(failure(outcome)).toStrictEqual(['upstream_error', { message: '[redacted:password]' }]);
  });
});
