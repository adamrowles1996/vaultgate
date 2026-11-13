/**
 * ACT-133: the caller tag (ACT-131) of every call, so the Writes view and the
 * export name the session behind a write. Rows written before this migration
 * have none.
 */
import type { Migration } from './types.ts';

export const callerTag: Migration = {
  version: 7,
  name: 'caller-tag',
  sql: 'ALTER TABLE action_calls ADD COLUMN caller_tag TEXT;',
};
