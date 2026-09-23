/**
 * Schema v3 (spec 07 §7.2, STORE-9): the vault connection the operator saves
 * on the account page. One row, `id = 1`; the client secret and the master
 * password are sealed by the secret box under keys derived from
 * `VAULTGATE_SECRET_KEY` (distinct HKDF purposes), never stored in clear.
 * `updated_by` is the operator id; it is not a foreign key so the connection
 * outlives an operator row that is ever recreated.
 */
import type { Migration } from './types.ts';

const SQL = `
CREATE TABLE vault_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_url TEXT,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  master_password_ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
`;

export const vaultSettings: Migration = { version: 3, name: 'vault-settings', sql: SQL };
