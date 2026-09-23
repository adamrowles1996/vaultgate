# 08 Configuration

All configuration is environment variables, validated once at start-up by a
zod schema in `src/config/`. Any `*_FILE` variant reads the value from a
file (Docker/Kubernetes secrets convention) and takes precedence over the
plain variable. Invalid configuration exits with status 1 and a list of every
problem, not just the first.

## 8.1 Reference

| Variable                              | Required | Default            | Description                                                                                                                                                                                        |
| ------------------------------------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULTGATE_PUBLIC_URL`                | yes      |                    | Public origin, e.g. `https://vault.example.com`. Must be `https` unless the host is `localhost`/loopback. Defines the issuer and the canonical resource `${URL}/mcp`.                              |
| `VAULTGATE_HOST`                      | no       | `127.0.0.1`        | Bind address. Set `0.0.0.0` inside containers.                                                                                                                                                     |
| `VAULTGATE_PORT`                      | no       | `8080`             | Bind port.                                                                                                                                                                                         |
| `VAULTGATE_TRUST_PROXY`               | no       | `false`            | Honour `X-Forwarded-For/Proto/Host` from the immediate upstream. Required behind a reverse proxy or Container Apps ingress.                                                                        |
| `VAULTGATE_TRUSTED_PROXY_HOPS`        | no       | `1`                | With `VAULTGATE_TRUST_PROXY`, which `X-Forwarded-For` entry is the client, counted from the right (`1`–`10`). Entries to its left are ignored; a malformed entry falls back to the socket address. |
| `VAULTGATE_ALLOWED_ORIGINS`           | no       | (public URL only)  | Comma-separated extra browser origins allowed on `/mcp`.                                                                                                                                           |
| `VAULTGATE_DATA_DIR`                  | no       | `./data`           | SQLite database and `bw` app-data. Must be persistent and writable by the service user.                                                                                                            |
| `VAULTGATE_SECRET_KEY`                | yes      |                    | ≥ 32 bytes, base64 or hex. Root key for TOTP-secret encryption and HMACs. Back it up with the database.                                                                                            |
| `VAULTGATE_BW_PASSWORD`               | no       |                    | First-boot seed (CFG-5): Bitwarden master password. Prefer `VAULTGATE_BW_PASSWORD_FILE`.                                                                                                           |
| `VAULTGATE_BW_CLIENT_ID`              | no       |                    | First-boot seed (CFG-5): Bitwarden personal API key client id (`user.…`).                                                                                                                          |
| `VAULTGATE_BW_CLIENT_SECRET`          | no       |                    | First-boot seed (CFG-5): Bitwarden personal API key client secret. Prefer the `_FILE` form.                                                                                                        |
| `VAULTGATE_BW_SERVER`                 | no       | (bitwarden.com US) | First-boot seed (CFG-5): `https://` URL of a self-hosted server or Vaultwarden, or `bitwarden.eu`.                                                                                                 |
| `VAULTGATE_BW_BIN`                    | no       | `bw`               | Path to the Bitwarden CLI binary.                                                                                                                                                                  |
| `VAULTGATE_BW_SYNC_INTERVAL`          | no       | `15m`              | Vault sync period (`30s`, `5m`, `1h`). Minimum `1m`.                                                                                                                                               |
| `VAULTGATE_ENABLE_WRITE_SCOPE`        | no       | `false`            | Allow clients to request `vault:write`.                                                                                                                                                            |
| `VAULTGATE_OAUTH_CLIENTS`             | no       | `[]`               | JSON array of pre-registered public clients: `[{"client_id":"…","client_name":"…","redirect_uris":["…"]}]`.                                                                                        |
| `VAULTGATE_BOOTSTRAP_TOKEN`           | no       | (generated)        | Preset first-run token for automated installs. Ignored once an operator exists.                                                                                                                    |
| `VAULTGATE_ACCESS_TOKEN_TTL`          | no       | `1h`               | Access token lifetime. Range `5m`–`24h`.                                                                                                                                                           |
| `VAULTGATE_REFRESH_TOKEN_TTL`         | no       | `30d`              | Refresh token absolute lifetime. Range `1h`–`365d`.                                                                                                                                                |
| `VAULTGATE_SESSION_TTL`               | no       | `12h`              | Operator session absolute lifetime.                                                                                                                                                                |
| `VAULTGATE_AUDIT_RETENTION_DAYS`      | no       | `365`              | Audit event retention.                                                                                                                                                                             |
| `VAULTGATE_SQLITE_NETWORK_FS`         | no       | `false`            | Use network-filesystem-safe SQLite settings (Azure Files). Single replica only.                                                                                                                    |
| `VAULTGATE_LOG_LEVEL`                 | no       | `info`             | `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                                                                                                                                                |
| `VAULTGATE_LOG_FORMAT`                | no       | `json`             | `json` or `pretty` (development only).                                                                                                                                                             |
| `VAULTGATE_ENABLE_ACTIONS`            | no       | `false`            | Actions layer master switch (spec 13 §13.14). Off: no `actions:*` scope is advertised or effective, no actions tool is listed, the account section is hidden.                                      |
| `VAULTGATE_ACTIONS_ENABLE_HTTP`       | no       | `false`            | Enables the `http` connector (and the `graph` adapter) and `actions:http`.                                                                                                                         |
| `VAULTGATE_ACTIONS_ENABLE_SQL`        | no       | `false`            | Enables the `sql` connector, `actions:sql.read` and `actions:sql.write`.                                                                                                                           |
| `VAULTGATE_ACTIONS_ENABLE_SSH`        | no       | `false`            | Enables the `ssh` connector and `actions:ssh`.                                                                                                                                                     |
| `VAULTGATE_ACTIONS_ENABLE_WINRM`      | no       | `false`            | Enables the `winrm` connector and `actions:winrm`.                                                                                                                                                 |
| `VAULTGATE_ACTIONS_ENABLE_BROWSER`    | no       | `false`            | Enables the `browser` connector and `actions:browser`. Requires `VAULTGATE_ACTIONS_BROWSER_CDP_URL`.                                                                                               |
| `VAULTGATE_ACTIONS_BROWSER_CDP_URL`   | no       |                    | `ws://` or `wss://` URL of the Chromium sidecar's DevTools endpoint (spec 14 §14.7). Must not be a public address.                                                                                 |
| `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` | no       | `false`            | Allows `ssh`/`winrm` targets to be saved with `any_command: true` (ACT-88). Turning it off later makes such targets refuse every call.                                                             |

- **CFG-1** Every secret-bearing variable (`*_PASSWORD`, `*_SECRET`, `*_KEY`, `*_TOKEN`) has a
  `_FILE` variant. The file must be readable only by the service user; a world-readable secret
  file is a start-up warning. An empty file means unset, as an empty variable does.
- **CFG-2** Durations accept `<number><s|m|h|d>`; anything else is a validation error.
- **CFG-3** The resolved configuration is logged at start-up with every secret replaced by
  `[set]` or `[unset]`, so operators can confirm what the process saw without exposing values.
  The eight `VAULTGATE_ENABLE_ACTIONS`/`VAULTGATE_ACTIONS_*` variables appear under `actions`
  (ACT-68); a connector switch set without the master switch is a start-up warning, not an
  error (ACT-67).
- **CFG-4** `.env` files are loaded only by `npm run dev` (Node's `--env-file-if-exists`); the
  production entrypoint reads the process environment only.
- **CFG-5** The Bitwarden connection is operator data, not configuration: the account page
  (ID-25) is its canonical source and stores it encrypted (STORE-9). The four `VAULTGATE_BW_*`
  connection variables are optional seeds for the first boot, honoured only while no connection
  has been stored and only when the three credential variables are all set (VAULT-18). Changing
  them later has no effect until the stored connection is removed; the log line
  `configuration loaded` shows each as `[set]` or `[unset]` either way.
