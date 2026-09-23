/**
 * The `action_sessions` rows the engine closes on the revocation paths of
 * spec §14.7.3 (ACT-8, ACT-10, ACT-96): the registry that opens and drives
 * sessions is M15's; this is the part every earlier milestone needs.
 */
import { run } from '../storage/query.ts';

import type { DatabaseSync } from 'node:sqlite';

export type CloseReason =
  'agent' | 'idle' | 'absolute' | 'revoked' | 'target_changed' | 'operator' | 'shutdown' | 'error';

export type SessionFilter = { readonly targetId: string } | { readonly clientId: string };

/**
Closes every open session matching the filter and yields how many were.
*/
export function closeSessions(
  database: DatabaseSync,
  filter: SessionFilter,
  reason: CloseReason,
  at: number,
): number {
  const [column, value] =
    'targetId' in filter ? ['target_id', filter.targetId] : ['client_id', filter.clientId];
  return run(
    database,
    `UPDATE action_sessions SET closed_at = ?, close_reason = ? WHERE closed_at IS NULL AND ${column} = ?`,
    at,
    reason,
    value,
  );
}
