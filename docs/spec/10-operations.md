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

| Probe      | Meaning                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz` | Process is up and the event loop responds. Always `200` once listening.                                                                                                                                                                                                                                                                                        |
| `/readyz`  | Store open and migrated, `bw serve` unlocked. `200` with `{"status":"ok","vault":{"ready":true,"lastSyncAt":…}}`; `503` otherwise, with `failing` naming each component that is not ready and the same `vault` object. `lastSyncAt` is the ISO 8601 time of the last successful sync since start-up, or `null`; a failed sync leaves `ready` `true` (VAULT-9). |

- **OPS-4** Both probes are unauthenticated, cacheless and reveal no version or configuration;
  the vault detail on `/readyz` is limited to readiness and the time of the last sync.

## 10.3 Audit export

- **OPS-5** The operator account page offers audit export as JSON Lines or CSV for a date range,
  gated by re-authentication (ID-15). The same export is available as
  `node dist/cli.js audit export --from --to` for scripted retention. The window is half-open
  (`from` inclusive, `to` exclusive, ISO 8601, UTC), rows are newest first, CSV follows RFC 4180
  with a header row, and the CLI opens the store read-only under the server's configuration (a
  store that was never created exports as empty). On a network filesystem the server holds the
  exclusive lock (STORE-2), so use the account page export while it runs.

## 10.4 Rate limits (summary)

| Surface            | Limit                        | Key             |
| ------------------ | ---------------------------- | --------------- |
| `/login` (POST)    | 5 failures / 15 min, backoff | ip and operator |
| `/oauth/token`     | 60 / min                     | ip              |
| `/oauth/register`  | 10 / hour                    | ip              |
| `/oauth/authorize` | 30 / min                     | session         |
| `/mcp` tool calls  | 120 / min                    | token           |
| CIMD fetches       | 30 / min                     | process-wide    |

- **OPS-6** Limits are in-memory token buckets (single replica). When `VAULTGATE_TRUST_PROXY` is
  off, the socket address is the client ip; forwarded headers are ignored to prevent spoofing.

## 10.5 Upgrades

- **OPS-7** Releases are semver. Patch and minor upgrades are in-place (pull the new image,
  restart); migrations run automatically and are forward-only. A major version documents its
  migration in `CHANGELOG.md` under an "Upgrading" heading.
- **OPS-8** vaultgate refuses to start against a database written by a newer major version.

## 10.6 Incident actions

| Situation                             | Action                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A token may have leaked               | Account page → revoke the client, or `POST /oauth/revoke`. Family revocation cuts refresh too. |
| The operator password may have leaked | Account page → change password (invalidates all sessions).                                     |
| `VAULTGATE_SECRET_KEY` leaked         | Rotate the key, restart; TOTP re-enrolment is required (STORE-8), tokens are unaffected.       |
| Master password rotated in Bitwarden  | Update `VAULTGATE_BW_PASSWORD(_FILE)`, restart. Nothing else changes.                          |
| Compromise suspected                  | Stop the service (locks the vault), rotate the API key in Bitwarden, review the audit export.  |
