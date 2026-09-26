/**
 * The snapshot each code target's calls without a ref answer from, kept in
 * `action_code_snapshots` (13.13, ACT-108) so that after a restart a moved
 * ref is still answered from it with `stale: true` rather than built while
 * the call waits. The engine lends it to the connector (`engine-services.ts`);
 * the connector never reaches the store itself. A row goes with its target
 * (`ON DELETE CASCADE`); a row for a target that no longer exists is never
 * written, and a write that fails is logged and dropped, since the next call
 * finds the snapshot again.
 */
import { z } from 'zod';

import { all, run } from '../storage/query.ts';

import type { Logger } from '../logger.ts';
import type { KeptSnapshot, KeptSnapshots } from './connectors/connector.ts';
import type { DatabaseSync } from 'node:sqlite';

const rowSchema = z.object({
  target_id: z.string(),
  snapshot_key: z.string(),
  fingerprint: z.string(),
  commit_sha: z.string(),
  ref: z.string(),
  indexed_at: z.number(),
});

const KEEP = `
INSERT INTO action_code_snapshots (target_id, snapshot_key, fingerprint, commit_sha, ref, indexed_at)
SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM action_targets WHERE id = ?)
ON CONFLICT (target_id) DO UPDATE SET
  snapshot_key = excluded.snapshot_key,
  fingerprint = excluded.fingerprint,
  commit_sha = excluded.commit_sha,
  ref = excluded.ref,
  indexed_at = excluded.indexed_at`;

function safely(logger: Logger, what: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      `code snapshot not ${what}; the next call looks it up again`,
    );
  }
}

export function keptSnapshots(database: DatabaseSync, logger: Logger): KeptSnapshots {
  return {
    load: (): readonly KeptSnapshot[] =>
      all(
        database,
        'SELECT target_id, snapshot_key, fingerprint, commit_sha, ref, indexed_at FROM action_code_snapshots ORDER BY target_id',
        rowSchema,
      ).map((row) => ({
        targetId: row.target_id,
        key: row.snapshot_key,
        fingerprint: row.fingerprint,
        commit: row.commit_sha,
        ref: row.ref,
        indexedAt: row.indexed_at,
      })),
    keep(snapshot) {
      const { targetId, key, fingerprint, commit, ref, indexedAt } = snapshot;
      safely(logger, 'kept', () => {
        run(database, KEEP, targetId, key, fingerprint, commit, ref, indexedAt, targetId);
      });
    },
    forget(targetId) {
      safely(logger, 'forgotten', () => {
        run(database, 'DELETE FROM action_code_snapshots WHERE target_id = ?', targetId);
      });
    },
  };
}
