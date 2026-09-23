/**
 * Schema v4 (spec 13 §13.13, ACT-64, ACT-65): the actions layer.
 *
 * `action_targets` holds destinations, the vault item id with the mapped
 * field names, and policy; never a secret. `action_grants` joins a target to
 * an OAuth client by `oauth_clients.client_id`, the value every consent and
 * token row already carries. `action_calls` is the per-call trail and has no
 * foreign key on purpose: it outlives the target (ACT-8) and carries the name
 * and connector redundantly for that reason; `target_id`, `connector` and
 * `revision` are NULL for a call that named a target that does not exist.
 * `action_sessions` is the record and revocation handle of a browser
 * session; the live context lives in the sidecar and the row holds the
 * session id's SHA-256 only. `confirmation_nonce` is unique so a
 * confirmation is consumed exactly once (ACT-46).
 */
import type { Migration } from './types.ts';

const SQL = `
CREATE TABLE action_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('http', 'sql', 'ssh', 'winrm', 'browser')),
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

CREATE TABLE action_calls (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  target_id TEXT,
  target_name TEXT NOT NULL,
  connector TEXT,
  revision INTEGER,
  tool TEXT NOT NULL,
  session_id_hash TEXT,
  client_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  operation TEXT CHECK (operation IN ('read', 'write', 'shell', 'act')),
  classification TEXT,
  arguments TEXT NOT NULL,
  arguments_truncated INTEGER NOT NULL CHECK (arguments_truncated IN (0, 1)),
  output_bytes INTEGER NOT NULL,
  output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  elicitation TEXT NOT NULL CHECK (
    elicitation IN ('not_required', 'accepted', 'declined', 'cancelled', 'unavailable', 'invalid')
  ),
  confirmation_nonce TEXT,
  request_id TEXT,
  ip TEXT
);
CREATE INDEX idx_action_calls_at ON action_calls (at);
CREATE INDEX idx_action_calls_target_id_at ON action_calls (target_id, at);
CREATE UNIQUE INDEX idx_action_calls_confirmation_nonce ON action_calls (confirmation_nonce);

CREATE TABLE action_sessions (
  id_hash TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK (
    close_reason IN ('agent', 'idle', 'absolute', 'revoked', 'target_changed', 'operator', 'shutdown', 'error')
  ),
  calls INTEGER NOT NULL
);
CREATE INDEX idx_action_sessions_client_id ON action_sessions (client_id);
`;

export const actions: Migration = { version: 4, name: 'actions', sql: SQL };
