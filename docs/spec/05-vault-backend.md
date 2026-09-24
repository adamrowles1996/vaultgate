# 05 Vault backend: managed `bw serve`

vaultgate reaches the vault through the Bitwarden CLI's Vault Management API
(`bw serve`), run as a child process that only ever listens on loopback. This
is the one supported path to a personal vault that works identically against
bitwarden.com (US and EU), self-hosted Bitwarden and Vaultwarden.

## 5.1 Process lifecycle

- **VAULT-1** `src/bitwarden/serve-process.ts` is the only module that spawns processes (ARCH-2).
  It runs `bw serve --hostname 127.0.0.1 --port <free port chosen by binding port 0 first>`
  with `BITWARDENCLI_APPDATA_DIR=${DATA_DIR}/bw/<n>` (`n` is the credential generation, VAULT-8;
  `1` at start-up) and a minimal environment (no inherited
  variables other than `PATH`, `HOME`, `TMPDIR`; vaultgate adds `BW_NOINTERACTION=true` so the
  CLI can never wait on a prompt).
- **VAULT-2** The `bw` binary path comes from `VAULTGATE_BW_BIN` (default: `bw` on `PATH`). At
  start-up vaultgate runs `bw --version`, logs it, and refuses versions below the minimum recorded
  in `src/bitwarden/versions.ts`.
- **VAULT-3** Server selection: before a login, `bw config server <url>` is run when the
  connection names a server (any `https://` URL for self-hosted / Vaultwarden, or the literal
  `bitwarden.eu`). When it names none but the app-data directory in use still records a server
  from an earlier connection, `bw config server bitwarden.com` resets the CLI to its cloud
  default first, so a login never goes to a server the connection no longer names. The server
  comes from the stored connection or, for a seed, `VAULTGATE_BW_SERVER` (VAULT-18).
- **VAULT-4** Login: if `bw status` (run before `bw serve`) reports `unauthenticated`, vaultgate
  runs `bw login --apikey` with `BW_CLIENTID` and `BW_CLIENTSECRET` in the child environment only.
  Unlock: `POST /unlock` with the master password in the request body over loopback. The
  credentials are resolved once per generation (VAULT-18) and kept only in process memory.
- **VAULT-5** Readiness is `true` only after `GET /status` reports `unlocked`. Until then `/readyz`
  answers `503` and MCP tool calls return a structured `vault_unavailable` error.
- **VAULT-6** If the child exits, vaultgate restarts it with exponential backoff (1 s → 60 s),
  re-unlocks, and logs each attempt. After 10 consecutive failures readiness stays `false` and
  the failure is logged at `error` level once per minute. A start-up failure (missing binary,
  rejected login or master password, `bw serve` not answering within 30 s) follows the same
  backoff; only a CLI below the minimum version (VAULT-2) stops the retry loop, since no retry
  can fix it. A fresh `bw serve` accepts connections a moment before its command handlers are
  ready, so for the first 10 s after it is spawned a `POST /unlock` answered with something other
  than the JSON envelope (a protocol error) is retried every 250 ms rather than counted as a
  failed attempt; after that window it is a failed attempt like any other. A `POST /unlock`
  whose connection is refused or reset, or that reaches the VAULT-16 bound, is a failed attempt
  at once: the child is stopped and, after the backoff, the same generation is started again
  without a second login, since its app-data directory already holds the session (VAULT-8). Each
  attempt is logged at `warn` with the error's message, which says which of those it was. An exit
  after the vault was ready is one more consecutive failure unless the child had been ready for at least
  5 minutes, in which case the count starts afresh at 1; so a child that dies on every scheduled
  sync reaches the backoff and the `error`-level escalation like any other failure. The
  `bw serve exited` log line carries the exit code, signal, uptime and the last 40 lines
  (at most 4 KiB) the child wrote to stdout and stderr, with anything resembling a session key
  (`BW_SESSION=…`, tokens of 40 or more base64 characters) or a password assignment redacted
  before it is logged (VAULT-14).
- **VAULT-7** On `SIGTERM`/`SIGINT` vaultgate calls `POST /lock`, then sends `SIGTERM` to the
  child and waits up to 5 s before `SIGKILL`, logging `vault locked` and `bw serve stopped` as each
  step completes.
- **VAULT-8** vaultgate never calls `bw logout`. Instead each credential generation (the one
  resolved at start-up and every account-page reconfiguration, VAULT-18) gets its own CLI
  app-data directory, `${DATA_DIR}/bw/<n>` with `n` counting from 1 per process. A switch
  removes whatever a previous process left under the new number and logs in afresh there, so an
  old session is never reused and no logout is needed; once the new generation is unlocked the
  retired generation's directory is deleted, and when the switch fails the new generation's
  directory is deleted and the previous one, still intact, is resumed. A directory whose session
  may still be wanted is never deleted, and `bw/1` survives restarts so an unchanged connection
  reuses its session (VAULT-4).
- **VAULT-18** Credential source and reconfiguration. At start-up the backend resolves its
  credentials in this order: the connection stored by the Vault page (ID-25; `vault_settings`,
  STORE-9, decrypted under `VAULTGATE_SECRET_KEY`); otherwise the environment seed when all
  three of `VAULTGATE_BW_CLIENT_ID`, `VAULTGATE_BW_CLIENT_SECRET` and `VAULTGATE_BW_PASSWORD` are
  set (a partial set is logged and ignored; a stored row that does not decrypt is logged and
  skipped); otherwise the backend is _unconfigured_: no process is spawned, `/readyz` answers
  `503` naming `vault` with `configured: false`, and tool calls return `vault_unavailable` as for
  a locked vault. `reconfigure(credentials)` (driven by ID-25) locks and stops the running child
  (VAULT-7 steps), starts the new generation in a fresh app-data directory (VAULT-8: version
  gate, `bw config server`, `bw login --apikey`, `bw serve`, unlock, initial sync), and only then
  retires the old one; readiness is `false` in between. A failure at any step stops whatever was
  started, restores the previous generation (or the unconfigured state) and returns
  `vault_unavailable` with one fixed, secret-free phrase per cause (rejected API key, rejected
  master password, refused server, `bw serve` not answering, CLI too old, or "see the log");
  the underlying error is logged. Only one reconfiguration runs at a time and none during
  shutdown; both are refused with `vault_unavailable`.

## 5.2 Synchronisation

- **VAULT-9** `POST /sync` runs after unlock and then every `VAULTGATE_BW_SYNC_INTERVAL` (default
  15 minutes, minimum 1 minute). Each successful sync, the initial one included, is logged at
  `info` as `vault synced` with its duration. A sync failure, including the initial one, is
  logged and does not affect readiness; the cached vault continues to serve reads. The supervisor
  records the time of the last successful sync and the error code of the last failed one, and
  `/readyz` reports the former (spec §10.2).
- **VAULT-10** Write tools trigger no sync; they poll `GET /object/item/<id>` every 100 ms until
  the new `revisionDate` (or, for trash, the `deletedDate`) is visible, bounded to 5 s, so a
  read-after-write is consistent. If the bound elapses the write has still succeeded, so the last
  observed item is returned rather than an error.
- **VAULT-17** A `POST /sync` answered with something other than the JSON envelope (a protocol
  error) while `bw serve` is still running is retried once after 2 s before it is reported as a
  failed sync; a server-side sync can complete even when the reply is malformed. A protocol error
  from a sync is never treated as a failed start or restart (VAULT-6): only the child's exit is,
  and a sync that fails because the child exited is not counted a second time.

## 5.3 Vault client

- **VAULT-11** `VaultClient` is a TypeScript interface with a `BwServeVaultClient` implementation
  and an `InMemoryVaultClient` fake in `src/test-support/`. Tool code depends on the interface only.
- **VAULT-12** Every response from `bw serve` is validated with a zod schema before use; unknown
  shapes fail closed with a `vault_protocol_error`.
- **VAULT-13** Item types supported: login (1), secure note (2), card (3), identity (4), SSH key (5).
  Card and identity items are listed and summarised but their sensitive fields are exposed only
  through `get_secret`.

| Operation        | `bw serve` call                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------- |
| status           | `GET /status`                                                                                |
| sync             | `POST /sync`                                                                                 |
| search items     | `GET /list/object/items?search=&folderid=&collectionid=&organizationid=&url=&trash=`         |
| get item         | `GET /object/item/{id}`                                                                      |
| get field        | `GET /object/{password\|username\|uri\|totp\|notes}/{id}`                                    |
| list folders     | `GET /list/object/folders`                                                                   |
| list collections | `GET /list/object/collections`                                                               |
| generate         | `GET /generate?length=&uppercase=&lowercase=&number=&special=&passphrase=&words=&separator=` |
| create item      | `POST /object/item`                                                                          |
| update item      | `PUT /object/item/{id}`                                                                      |
| trash item       | `DELETE /object/item/{id}`                                                                   |
| create folder    | `POST /object/folder`                                                                        |
| unlock / lock    | `POST /unlock`, `POST /lock`                                                                 |

## 5.4 Error mapping

| Condition                              | Tool error code        | HTTP (non-MCP) |
| -------------------------------------- | ---------------------- | -------------- |
| `bw serve` not running or not unlocked | `vault_unavailable`    | 503            |
| Item, folder or secret field not found | `not_found`            | n/a            |
| Ambiguous name match                   | `ambiguous`            | n/a            |
| Vault rejected write (validation)      | `invalid_item`         | n/a            |
| Unexpected response shape              | `vault_protocol_error` | 502            |

- **VAULT-14** Error messages returned to agents never contain vault content, the master
  password, session keys or file paths. The client therefore never forwards the text of a
  `bw serve` rejection; every message is a fixed phrase of vaultgate's own, one per error code
  plus, under `vault_unavailable`, one for a rejected master password and one for the VAULT-16
  timeout.
- **VAULT-16** Every `bw serve` call is bounded to 60 s (the same bound as a one-shot CLI
  command). A call that has not answered by then is aborted and reported as `vault_unavailable`
  with the message `the vault did not answer within 60 s`, distinct from the message for a refused
  or reset connection, so a `bw serve` that stops answering can never leave an MCP request hanging
  with nothing logged or hold up shutdown, and the log tells a stalled child from one that is gone.

## 5.5 Secret material in memory

- **VAULT-15** The master password and API secret of a generation are held in a single
  `Credentials` object, passed by reference, and zero-filled (`Buffer.fill(0)`) when the
  generation is retired (a successful switch, a failed switch's new generation) and on shutdown.
  They are never serialised, never placed on a `Config` object that is logged, and the logger
  redacts the field names regardless (`masterPassword`, `clientSecret`). At rest they exist only
  as the `vault_settings` ciphertext (STORE-9).
