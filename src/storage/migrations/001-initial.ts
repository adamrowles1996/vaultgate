/**
 * Schema v1 (spec 07 §7.2).
 *
 * Conventions, chosen once here and binding for every later migration:
 *   - Identifiers (`id`, `*_id`) are TEXT UUIDs.
 *   - Every `*_at` column (and `audit_events.at`) is an INTEGER holding
 *     milliseconds since the Unix epoch, as produced by `Date.now()`.
 *   - JSON columns are TEXT holding a serialised JSON document.
 *   - Booleans are INTEGER 0/1 with a CHECK constraint.
 *   - Secrets never appear in clear: `*_hash` columns hold a hex digest and
 *     `*_ciphertext` columns hold an encrypted blob (STORE-4).
 *
 * `schema_migrations` is owned by the migration runner, which creates it
 * before applying this file, so it is deliberately absent here.
 */
import type { Migration } from './types.ts';

const SQL = `
CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_ciphertext TEXT,
  totp_last_step INTEGER,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  used_at INTEGER
);
CREATE INDEX idx_recovery_codes_operator_id ON recovery_codes (operator_id);

CREATE TABLE bootstrap_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reauthenticated_at INTEGER,
  csrf_token TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_operator_id ON sessions (operator_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE login_attempts (
  subject TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
);
CREATE INDEX idx_login_attempts_subject_attempted_at ON login_attempts (subject, attempted_at);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('cimd', 'dcr', 'preregistered')),
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE cimd_cache (
  client_id TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  etag TEXT
);
CREATE INDEX idx_cimd_cache_expires_at ON cimd_cache (expires_at);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_consents_operator_id_client_id ON consents (operator_id, client_id);

CREATE TABLE authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  consent_id TEXT NOT NULL REFERENCES consents (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_authorization_codes_expires_at ON authorization_codes (expires_at);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id TEXT NOT NULL,
  parent_id TEXT REFERENCES tokens (id) ON DELETE SET NULL,
  replaced_by_id TEXT REFERENCES tokens (id) ON DELETE SET NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  consent_id TEXT NOT NULL REFERENCES consents (id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  resource TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX idx_tokens_family_id ON tokens (family_id);
CREATE INDEX idx_tokens_consent_id ON tokens (consent_id);
CREATE INDEX idx_tokens_expires_at ON tokens (expires_at);

CREATE TABLE pending_authorizations (
  id TEXT PRIMARY KEY,
  session_binding_hash TEXT NOT NULL,
  parameters TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_authorizations_expires_at ON pending_authorizations (expires_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  operator_id TEXT,
  client_id TEXT,
  token_prefix TEXT,
  item_id TEXT,
  field TEXT,
  request_id TEXT,
  ip TEXT,
  duration_ms INTEGER,
  details TEXT
);
CREATE INDEX idx_audit_events_at ON audit_events (at);
CREATE INDEX idx_audit_events_operator_id_at ON audit_events (operator_id, at);
CREATE INDEX idx_audit_events_client_id_at ON audit_events (client_id, at);
`;

export const initial: Migration = { version: 1, name: 'initial', sql: SQL };
