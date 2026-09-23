# 07 Storage

## 7.1 Engine

- **STORE-1** SQLite through Node's built-in `node:sqlite` (`DatabaseSync`). No native addon.
  File: `${VAULTGATE_DATA_DIR}/vaultgate.sqlite`, created `0600`.
- **STORE-2** Pragmas at open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5000`. When `VAULTGATE_SQLITE_NETWORK_FS=true` (Azure Files) the journal mode is
  `TRUNCATE`, `synchronous=FULL`, and `locking_mode=EXCLUSIVE`, and the deployment MUST run a
  single replica (see 09).
- **STORE-3** Migrations are numbered TypeScript modules in `src/storage/migrations/` (each
  exporting `{ version, name, sql }`, registered in `migrations/index.ts`), applied forward-only
  inside one transaction each and recorded in `schema_migrations(version, applied_at, checksum)`
  with the SHA-256 of the migration's SQL. Re-running is a no-op. A checksum mismatch on an
  applied migration, or an applied version this build does not know (OPS-8), is a fatal start-up
  error.

### Column conventions

- Identifiers (`id`, `*_id`) are TEXT UUIDs.
- Every `*_at` column and `audit_events.at` is an INTEGER holding milliseconds since the Unix
  epoch (`Date.now()`).
- JSON columns are TEXT holding a serialised document; booleans are INTEGER `0`/`1`.

## 7.2 Schema

| Table                    | Key columns                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operators`              | `id`, `email`, `password_hash`, `totp_secret_ciphertext`, `totp_last_step`, `created_at`, `password_changed_at`, `display_name` (deprecated)                                                                  |
| `recovery_codes`         | `operator_id`, `code_hash`, `used_at`                                                                                                                                                                         |
| `bootstrap_tokens`       | `token_hash`, `expires_at`, `consumed_at`                                                                                                                                                                     |
| `sessions`               | `id_hash`, `operator_id`, `created_at`, `last_seen_at`, `expires_at`, `reauthenticated_at`, `csrf_token`, `ip`, `user_agent`                                                                                  |
| `login_attempts`         | `subject` (`ip:…`, `email:…` or, in legacy mode, `operator:…`), `attempted_at`, `succeeded`                                                                                                                   |
| `oauth_clients`          | `id`, `client_id`, `mode` (`cimd`\|`dcr`\|`preregistered`), `client_name`, `redirect_uris` (JSON), `metadata` (JSON), `created_at`, `revoked_at`                                                              |
| `cimd_cache`             | `client_id`, `document` (JSON), `fetched_at`, `expires_at`, `etag`                                                                                                                                            |
| `consents`               | `id`, `operator_id`, `client_id`, `scopes` (JSON), `granted_at`, `revoked_at`                                                                                                                                 |
| `authorization_codes`    | `code_hash`, `client_id`, `consent_id`, `redirect_uri`, `code_challenge`, `resource`, `scopes` (JSON), `expires_at`, `used_at`                                                                                |
| `tokens`                 | `id`, `token_hash`, `kind` (`access`\|`refresh`), `family_id`, `parent_id`, `replaced_by_id`, `client_id`, `consent_id`, `scopes` (JSON), `resource`, `issued_at`, `expires_at`, `revoked_at`, `last_used_at` |
| `pending_authorizations` | `id`, `session_binding_hash`, `parameters` (JSON), `expires_at`                                                                                                                                               |
| `audit_events`           | `id`, `at`, `category`, `action`, `outcome`, `operator_id`, `client_id`, `token_prefix`, `item_id`, `field`, `request_id`, `ip`, `duration_ms`, `details` (JSON, secret-free)                                 |
| `vault_settings`         | `id` (always `1`), `server_url`, `client_id`, `client_secret_ciphertext`, `master_password_ciphertext`, `updated_at`, `updated_by` (operator id); schema v3 (STORE-9)                                         |
| `schema_migrations`      | `version`, `applied_at`, `checksum`                                                                                                                                                                           |

- `operators.email` (migration `operator-email`) is the login identifier: stored lower-cased,
  unique through an index on `lower(email)`, NULL only for a row written before that migration
  (ID-26). `display_name` is deprecated by the same migration: SQLite cannot relax its NOT NULL
  without rebuilding a table four others reference, so it stays, new rows write `''` and nothing
  reads it.
- **STORE-4** No table stores a raw token, code, session id, password or TOTP secret; hashes or
  ciphertext only.
- **STORE-9** The vault connection saved on the account page (ID-25) is the single
  `vault_settings` row. The API key client secret and the master password are sealed by the
  same AES-256-GCM secret box as the TOTP secret (ID-9) under two further HKDF purposes of
  `VAULTGATE_SECRET_KEY`, `vaultgate/vault-client-secret/v1` and
  `vaultgate/vault-master-password/v1`; the client id and server are plain. A row that does not
  open under the current key is reported as undecryptable and ignored at start-up (VAULT-18),
  never mistaken for a value. The row is written before the backend switches to it and put back
  (or removed) if the switch fails, so what is stored is always what runs.
- **STORE-5** Indexes exist for every lookup on the request hot path: `tokens(token_hash)`,
  `sessions(id_hash)`, `authorization_codes(code_hash)`, `audit_events(at)`.

## 7.3 Retention

- **STORE-6** A maintenance task runs hourly: delete expired authorization codes, expired
  sessions, expired bootstrap tokens, expired pending authorizations, tokens revoked or expired
  more than 7 days ago, login attempts older than 24 hours, CIMD cache rows past expiry, audit
  events past retention. Each run logs counts and the first run happens at start-up.

## 7.4 Backup and restore

- **STORE-7** The documented backup is `sqlite3 vaultgate.sqlite ".backup '<dest>'"` (or copying
  the file while the process is stopped). `bw` app-data under `${DATA_DIR}/bw/<n>` is a cache and
  needs no backup; it is rebuilt by login + sync.
- **STORE-8** `VAULTGATE_SECRET_KEY` (used for TOTP-secret encryption, the stored vault
  connection, STORE-9, and session-binding HMACs) MUST be backed up with the database; without it
  stored TOTP secrets are unrecoverable, the operator must use a recovery code and re-enrol, and
  the vault connection must be entered again on the account page. The database together with the
  key yields the vault credentials, which is why the key is backed up separately.
