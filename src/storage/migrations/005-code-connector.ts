/**
 * Schema v5 (spec 13a §13.13, ADR 0008): `action_targets.connector` admits
 * `code`. SQLite cannot alter a `CHECK`, so the table is rebuilt with the same
 * columns. Dropping it with foreign keys on would cascade to `action_grants`
 * (and migrations run in a transaction, where `PRAGMA foreign_keys` cannot
 * change), so the grants are copied aside, their table rebuilt after the
 * targets', and copied back. Nothing about a repository, snapshot or index is
 * stored: that lives in the code sidecar.
 */
import type { Migration } from './types.ts';

const SQL = `
CREATE TABLE action_grants_005 AS SELECT * FROM action_grants;
DROP TABLE action_grants;

CREATE TABLE action_targets_005 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('http', 'sql', 'ssh', 'winrm', 'browser', 'code')),
  destination TEXT NOT NULL,
  internal INTEGER NOT NULL CHECK (internal IN (0, 1)),
  credential TEXT NOT NULL,
  policy TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
INSERT INTO action_targets_005 SELECT * FROM action_targets;
DROP TABLE action_targets;
ALTER TABLE action_targets_005 RENAME TO action_targets;
CREATE UNIQUE INDEX idx_action_targets_name ON action_targets (name);

CREATE TABLE action_grants (
  target_id TEXT NOT NULL REFERENCES action_targets (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (target_id, client_id)
);
CREATE INDEX idx_action_grants_client_id ON action_grants (client_id);
INSERT INTO action_grants SELECT * FROM action_grants_005;
DROP TABLE action_grants_005;
`;

export const codeConnector: Migration = { version: 5, name: 'code-connector', sql: SQL };
