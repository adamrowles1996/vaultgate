# 07 Storage

## 7.1 Engine

- **STORE-1** SQLite through Node's built-in `node:sqlite` (`DatabaseSync`). No native addon.
  File: `${VAULTGATE_DATA_DIR}/vaultgate.sqlite`, created `0600`.
- **STORE-2** Pragmas at open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5000`. When `VAULTGATE_SQLITE_NETWORK_FS=true` (Azure Files) the journal mode is
  `TRUNCATE`, `synchronous=FULL`, and `locking_mode=EXCLUSIVE`, and the deployment MUST run a
  single replica (see 09).
- **STORE-3** Migrations are numbered SQL files in `src/storage/migrations/` applied forward-only
  inside one transaction each and recorded in `schema_migrations(version, applied_at, checksum)`.
  A checksum mismatch on an applied migration is a fatal start-up error.

## 7.2 Schema (v1)

| Table                    | Key columns                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operators`              | `id`, `display_name`, `password_hash`, `totp_secret_ciphertext`, `totp_last_step`, `created_at`, `password_changed_at`                                                                                        |
| `recovery_codes`         | `operator_id`, `code_hash`, `used_at`                                                                                                                                                                         |
| `bootstrap_tokens`       | `token_hash`, `expires_at`, `consumed_at`                                                                                                                                                                     |
| `sessions`               | `id_hash`, `operator_id`, `created_at`, `last_seen_at`, `expires_at`, `reauthenticated_at`, `csrf_token`, `ip`, `user_agent`                                                                                  |
| `login_attempts`         | `subject` (ip or operator id), `attempted_at`, `succeeded`                                                                                                                                                    |
| `oauth_clients`          | `id`, `client_id`, `mode` (`cimd`\|`dcr`\|`preregistered`), `client_name`, `redirect_uris` (JSON), `metadata` (JSON), `created_at`, `revoked_at`                                                              |
| `cimd_cache`             | `client_id`, `document` (JSON), `fetched_at`, `expires_at`, `etag`                                                                                                                                            |
| `consents`               | `id`, `operator_id`, `client_id`, `scopes` (JSON), `granted_at`, `revoked_at`                                                                                                                                 |
| `authorization_codes`    | `code_hash`, `client_id`, `consent_id`, `redirect_uri`, `code_challenge`, `resource`, `scopes` (JSON), `expires_at`, `used_at`                                                                                |
| `tokens`                 | `id`, `token_hash`, `kind` (`access`\|`refresh`), `family_id`, `parent_id`, `replaced_by_id`, `client_id`, `consent_id`, `scopes` (JSON), `resource`, `issued_at`, `expires_at`, `revoked_at`, `last_used_at` |
| `pending_authorizations` | `id`, `session_binding_hash`, `parameters` (JSON), `expires_at`                                                                                                                                               |
| `audit_events`           | `id`, `at`, `category`, `action`, `outcome`, `operator_id`, `client_id`, `token_prefix`, `item_id`, `field`, `request_id`, `ip`, `duration_ms`, `details` (JSON, secret-free)                                 |
| `schema_migrations`      | `version`, `applied_at`, `checksum`                                                                                                                                                                           |

- **STORE-4** No table stores a raw token, code, session id, password or TOTP secret; hashes or
  ciphertext only.
- **STORE-5** Indexes exist for every lookup on the request hot path: `tokens(token_hash)`,
  `sessions(id_hash)`, `authorization_codes(code_hash)`, `audit_events(at)`.

## 7.3 Retention

- **STORE-6** A maintenance task runs hourly: delete expired authorization codes, expired
  sessions, expired bootstrap tokens, tokens revoked or expired more than 7 days ago, login
  attempts older than 24 hours, CIMD cache rows past expiry, audit events past retention. Each
  run logs counts.

## 7.4 Backup and restore

- **STORE-7** The documented backup is `sqlite3 vaultgate.sqlite ".backup '<dest>'"` (or copying
  the file while the process is stopped). `bw` app-data under `${DATA_DIR}/bw` is a cache and
  needs no backup; it is rebuilt by login + sync.
- **STORE-8** `VAULTGATE_SECRET_KEY` (used for TOTP-secret encryption and session-binding HMACs)
  MUST be backed up with the database; without it stored TOTP secrets are unrecoverable and the
  operator must use a recovery code and re-enrol.
