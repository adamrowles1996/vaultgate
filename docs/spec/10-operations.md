# 10 Operations

## 10.1 Logging

- **OPS-1** One JSON line per event via pino; fields `time` (ISO 8601), `level`, `service`,
  `msg`, `requestId` where applicable. The redaction list in `src/logger.ts` is a backstop; code
  never places secrets on log objects in the first place.
- **OPS-2** Every HTTP request logs method, route template (not the raw path when it might carry
  ids), status, duration, client ip (proxy-aware), request id, and for `/mcp` the client id and
  tool name. Never headers, bodies or query strings.
- **OPS-3** `VAULTGATE_LOG_FORMAT=pretty` is for development; production logs stay JSON so a
  platform (Log Analytics, Loki, CloudWatch) can index them.

## 10.2 Health

| Probe      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz` | Process is up and the event loop responds. Always `200` once listening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/readyz`  | Store open and migrated, `bw serve` unlocked. `200` with `{"status":"ok"}`; `503` otherwise, with `failing` naming each component that is not ready. When an operator session cookie accompanies the request the answer also carries `vault` (`{"ready":…,"configured":…,"lastSyncAt":…}`): `configured` is `false` while no credentials exist at all (VAULT-18), which tells an unconfigured deployment from a failing one, and `lastSyncAt` is the ISO 8601 time of the last successful sync since start-up, or `null`; a failed sync leaves `ready` `true` (VAULT-9). The account page shows the same detail. |

- **OPS-4** Both probes are unauthenticated, cacheless and reveal no version or configuration;
  to an anonymous caller `/readyz` says only which component is not ready. The vault detail
  (whether any credentials are configured, the time of the last sync) is included only for a
  signed-in operator, who can also read it on the account page.

## 10.3 Audit export

- **OPS-5** The operator account page offers audit export as JSON Lines or CSV for a date range,
  gated by re-authentication (ID-15). The same export is available as
  `node dist/cli.js audit export --from --to` for scripted retention. The window is half-open
  (`from` inclusive, `to` exclusive, ISO 8601, UTC), rows are newest first, CSV follows RFC 4180
  with a header row, and the CLI opens the store read-only under the server's configuration (a
  store that was never created exports as empty). On a network filesystem the server holds the
  exclusive lock (STORE-2), so use the account page export while it runs.

## 10.4 Rate limits (summary)

| Surface            | Limit                        | Key                            |
| ------------------ | ---------------------------- | ------------------------------ |
| `/login` (POST)    | 5 failures / 15 min, backoff | ip and operator                |
| `/oauth/token`     | 60 / min                     | ip                             |
| `/oauth/revoke`    | 60 / min                     | ip                             |
| `/oauth/register`  | 10 / hour                    | ip                             |
| `/oauth/authorize` | 30 / min                     | session, or ip when signed out |
| `/mcp` tool calls  | 120 / min                    | token                          |
| CIMD fetches       | 30 / min                     | process-wide                   |

- **OPS-6** Limits are in-memory token buckets (single replica), each holding at most 10 000
  keys with the least recently used evicted first. When `VAULTGATE_TRUST_PROXY` is off, the socket
  address is the client ip; forwarded headers are ignored to prevent spoofing. When it is on, the
  client ip is the `X-Forwarded-For` entry `VAULTGATE_TRUSTED_PROXY_HOPS` from the right, the one
  the trusted proxy wrote; anything to its left is client-supplied and ignored, and an entry that
  is not an IP literal falls back to the socket address. The proxy should overwrite the inbound
  header rather than append to it. Anonymous `/oauth/authorize` requests are keyed by this ip,
  never by the client-chosen binding cookie.

## 10.5 Upgrades

- **OPS-7** Releases are semver. Patch and minor upgrades are in-place (pull the new image,
  restart); migrations run automatically and are forward-only. A major version documents its
  migration in `CHANGELOG.md` under an "Upgrading" heading.
- **OPS-8** vaultgate refuses to start against a database written by a newer major version.

## 10.6 Incident actions

| Situation                             | Action                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A token may have leaked               | Account page → revoke the client, or `POST /oauth/revoke`. Family revocation cuts refresh too.                                                                                                           |
| The operator password may have leaked | Account page → change password (invalidates all sessions).                                                                                                                                               |
| `VAULTGATE_SECRET_KEY` leaked         | Rotate the key, restart; TOTP re-enrolment and re-entering the vault connection are required (STORE-8), tokens are unaffected. Rotate the Bitwarden API key too if the database may have leaked with it. |
| Master password rotated in Bitwarden  | Account page → Vault connection → enter the new master password, leave the client secret blank, save (ID-25). No restart.                                                                                |
| API key rotated in Bitwarden          | Account page → Vault connection → enter the new client id and secret, leave the master password blank, save. The CLI session is replaced (VAULT-8).                                                      |
| Compromise suspected                  | Stop the service (locks the vault), rotate the API key in Bitwarden, review the audit export.                                                                                                            |
