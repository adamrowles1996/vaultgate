/**
 * ACT-9: an optional per-client ceiling, independent of the target policy.
 * Existing grants keep their policy-bound access; a read-only grant never
 * authorises writes, shells or browser actions, even with broader token scopes.
 */
import type { Migration } from './types.ts';

export const readOnlyGrants: Migration = {
  version: 6,
  name: 'read-only-grants',
  sql: 'ALTER TABLE action_grants ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));',
};
