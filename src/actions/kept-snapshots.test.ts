import { describe, expect, it } from 'vitest';

import { createHttpTarget, createActionsHarness } from '../test-support/actions-fixtures.ts';
import { captureLogger } from '../test-support/logging.ts';

import { keptSnapshots } from './kept-snapshots.ts';

import type { KeptSnapshot } from './connectors/connector.ts';
import type { DatabaseSync } from 'node:sqlite';

function snapshot(targetId: string, commit: string): KeptSnapshot {
  return {
    targetId,
    key: `${targetId}.0123456789abcdef.${commit}`,
    fingerprint: '0123456789abcdef',
    commit,
    ref: 'main',
    indexedAt: 7,
  };
}

describe('the kept snapshots (13.13, ACT-108)', () => {
  it('13.13 ACT-108 keeps one current snapshot per target, replaces it, and forgets it', async () => {
    const harness = createActionsHarness();
    const target = await createHttpTarget(harness);
    const { logger, lines } = captureLogger();
    const store = keptSnapshots(harness.database, logger);
    store.keep(snapshot(target.id, 'a'.repeat(40)));
    store.keep(snapshot(target.id, 'b'.repeat(40)));
    expect(store.load()).toStrictEqual([snapshot(target.id, 'b'.repeat(40))]);
    store.forget(target.id);
    expect([store.load(), lines()]).toStrictEqual([[], []]);
  });

  it('13.13 writes nothing for a target that no longer exists, and a row goes with its target', async () => {
    const harness = createActionsHarness();
    const target = await createHttpTarget(harness);
    const { logger } = captureLogger();
    const store = keptSnapshots(harness.database, logger);
    store.keep(snapshot('gone-1', 'a'.repeat(40)));
    store.keep(snapshot(target.id, 'a'.repeat(40)));
    expect(store.load().map((row) => row.targetId)).toStrictEqual([target.id]);
    harness.database.prepare('DELETE FROM action_targets WHERE id = ?').run(target.id);
    expect(store.load()).toStrictEqual([]);
  });

  it('ACT-108 a write that fails is logged by the error’s name and never thrown', async () => {
    const harness = createActionsHarness();
    const target = await createHttpTarget(harness);
    const { logger, lines } = captureLogger();
    const store = keptSnapshots(harness.database, logger);
    harness.database.exec('DROP TABLE action_code_snapshots');
    store.keep(snapshot(target.id, 'a'.repeat(40)));
    store.forget(target.id);
    // A driver that throws something other than an Error is named as unknown.
    const odd = {
      prepare: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a careless driver does
        throw 'text';
      },
    } as unknown as DatabaseSync;
    keptSnapshots(odd, logger).forget(target.id);
    expect(lines().map((line) => [line['msg'], line['error']])).toStrictEqual([
      ['code snapshot not kept; the next call looks it up again', 'Error'],
      ['code snapshot not forgotten; the next call looks it up again', 'Error'],
      ['code snapshot not forgotten; the next call looks it up again', 'unknown'],
    ]);
  });
});
