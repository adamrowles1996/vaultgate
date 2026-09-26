import { describe, expect, it } from 'vitest';

import { run } from '../../../storage/query.ts';
import { OPERATOR_ID, storedCalls } from '../../../test-support/actions-fixtures.ts';
import {
  codeCaller,
  codeTargetInput,
  createCodeHarness,
  createCodeTarget,
  OTHER_REPO,
  search,
  SHA,
  sidecarResult,
  type CodeHarness,
} from '../../../test-support/code-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';
import { VaultError } from '../../../vault/client.ts';

const ADDRESSES: Record<string, string[]> = {};

function lastFailureReason(code: CodeHarness): unknown {
  const failed = code.harness.audit.filter((event) => event.action === 'code_index_failed');
  return failed.at(-1)?.details?.['reason'];
}

describe('builds the engine cannot lend a target for (ACT-108)', () => {
  it('ACT-108 Rebuild of a disabled target builds nothing and is recorded as target_disabled', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code, { enabled: false });
    await code.harness.engine.code?.refresh(target.id, 'operator', false);
    expect([lastFailureReason(code), code.sidecar.builds]).toStrictEqual(['target_disabled', []]);
  });

  it('ACT-56 a build whose GitHub address is refused is recorded as destination_refused', async () => {
    const code = createCodeHarness({ harness: { addresses: ADDRESSES } });
    const target = await createCodeTarget(code);
    ADDRESSES['api.github.com'] = ['127.0.0.1'];
    try {
      await code.harness.engine.code?.refresh(target.id, 'operator', false);
    } finally {
      delete ADDRESSES['api.github.com'];
    }
    expect(lastFailureReason(code)).toBe('destination_refused');
  });

  it('ACT-54 a second repository whose credential cannot be fetched fails the call, and the first one lent is zeroed', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code);
    await createCodeTarget(code, {
      name: 'gadgets',
      destination: { repository: OTHER_REPO },
      mapping: { token_field: 'custom.API key' },
    });
    const { vault } = code.harness;
    const getSecret = vault.getSecret.bind(vault);
    vault.getSecret = (id, field) =>
      field.kind === 'customField'
        ? Promise.resolve({ ok: false, error: new VaultError('not_found', 'no such field') })
        : getSecret(id, field);
    const outcome = await code.harness.engine.call(codeCaller(), search(['widgets', 'gadgets']));
    expect(outcome.kind === 'error' && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'credential_unavailable',
      { repo: 'gadgets' },
    ]);
    expect(storedCalls(code.harness.database).map((row) => row.outcome)).toStrictEqual([
      'error:credential_unavailable',
      'error:credential_unavailable',
    ]);
  });
});

describe('revisions and removals racing their background work (ACT-108, ACT-109)', () => {
  it('ACT-1 ACT-108 a revision of a target whose stored row no longer validated builds, without a reset to compare against', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    run(
      code.harness.database,
      'UPDATE action_targets SET policy = \'{"max_top_k":9999}\' WHERE id = ?',
      target.id,
    );
    const {
      name: _name,
      connector: _connector,
      enabled: _enabled,
      ...changes
    } = codeTargetInput({ destination: { ref: 'v1.0' } });
    unwrapOk(await code.harness.engine.targets.update(target.id, changes, OPERATOR_ID));
    await code.settle();
    expect(code.sidecar.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(code.sidecar.builds.map((build) => build.spec.commit)).toStrictEqual([
      SHA.main,
      SHA.tag,
    ]);
  });

  it('ACT-109 a target deleted right after a revision builds nothing, and loses its snapshots', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    const {
      name: _name,
      connector: _connector,
      enabled: _enabled,
      ...changes
    } = codeTargetInput({ destination: { ref: 'v1.0' } });
    unwrapOk(await code.harness.engine.targets.update(target.id, changes, OPERATOR_ID));
    unwrapOk(code.harness.engine.targets.remove(target.id, OPERATOR_ID));
    await code.settle();
    expect([code.sidecar.builds.length, code.sidecar.snapshots.size]).toStrictEqual([1, 0]);
  });
});

describe('switching a target that no longer validates (ACT-1, ACT-108)', () => {
  it('ACT-1 ACT-108 enabling a target whose stored row no longer validates builds nothing', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code, { enabled: false });
    run(
      code.harness.database,
      'UPDATE action_targets SET policy = \'{"max_top_k":9999}\' WHERE id = ?',
      target.id,
    );
    unwrapOk(code.harness.engine.targets.setEnabled(target.id, true, OPERATOR_ID));
    await code.settle();
    expect([code.sidecar.builds, code.github.requests]).toStrictEqual([[], []]);
  });
});

describe('the reconciliation (ACT-109)', () => {
  it('ACT-109 a sidecar that cannot list its snapshots is left as it is', async () => {
    const code = createCodeHarness();
    await createCodeTarget(code);
    const key = `gone-1.0123456789abcdef.${SHA.main}`;
    code.sidecar.snapshots.set(key, {
      key,
      owner: 'gone-1',
      commit: SHA.main,
      createdAt: 1,
      variants: ['code'],
    });
    code.sidecar.script('list', { status: 500, body: Buffer.from('{"error":"internal_error"}') });
    await code.harness.engine.code?.reconcile();
    expect(code.sidecar.snapshots.has(key)).toBe(true);
  });

  it('ACT-109 a snapshot of a known target under a key vaultgate never made is deleted', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    code.sidecar.snapshots.set('foreign', {
      key: 'foreign',
      owner: target.id,
      commit: SHA.main,
      createdAt: 1,
      variants: ['code'],
    });
    await code.harness.engine.code?.reconcile();
    expect([code.sidecar.snapshots.has('foreign'), code.sidecar.snapshots.size]).toStrictEqual([
      false,
      1,
    ]);
  });

  it('ACT-1 ACT-109 the snapshots of a target whose stored row no longer validates are deleted', async () => {
    const code = createCodeHarness();
    const target = await createCodeTarget(code);
    run(
      code.harness.database,
      'UPDATE action_targets SET policy = \'{"max_top_k":9999}\' WHERE id = ?',
      target.id,
    );
    await code.harness.engine.code?.reconcile();
    expect(code.sidecar.snapshots.size).toBe(0);
    expect(code.sidecar.requests.at(-1)?.method).toBe('DELETE');
  });
});

describe('the connector outside the repo path (ACT-16)', () => {
  it('ACT-16 a code tool invoked by target, as the single-target path invokes a tool, runs the same', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code);
    const outcome = await code.harness.engine.call(codeCaller(), {
      tool: 'code_search',
      target: 'widgets',
      arguments: { target: 'widgets', query: 'widgets' },
    });
    expect(outcome.kind === 'ok' && outcome.result['repos']).toStrictEqual([
      expect.objectContaining({ repo: 'widgets', commit: SHA.main }),
    ]);
  });

  it('ACT-110 a list of names for a tool that takes none is refused as naming at most one', async () => {
    const code = createCodeHarness();
    await code.settle();
    const outcome = await code.harness.engine.call(codeCaller(), {
      tool: 'no_such_tool',
      target: 'a,b',
      targets: ['a', 'b'],
      arguments: {},
    });
    expect(outcome.kind === 'error' && outcome.error.detail).toStrictEqual({
      problem: 'repo: must name 1 to 1 distinct connections',
    });
  });

  it('ACT-110 the connector refuses a call over no repository at all', async () => {
    const code = createCodeHarness();
    await code.settle();
    const outcome = await code.connector.runMany?.([], {
      query: 'q',
      top_k: 5,
      max_snippet_lines: 10,
    });
    expect(outcome?.ok === false && [outcome.error.code, outcome.error.detail]).toStrictEqual([
      'connector_fault',
      { reason: 'internal', message: 'no repo' },
    ]);
  });
});
