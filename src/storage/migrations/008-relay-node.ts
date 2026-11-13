/**
 * RELAY-17: the tailnet node a relay token was issued to, kept on the token
 * row so the caller tag (ACT-131) can name the node, and through it the
 * session, behind every call made with that token. Tokens issued before this
 * migration, and every token the token endpoint issues, have none.
 */
import type { Migration } from './types.ts';

export const relayNode: Migration = {
  version: 8,
  name: 'relay-node',
  sql: 'ALTER TABLE tokens ADD COLUMN relay_node TEXT;',
};
