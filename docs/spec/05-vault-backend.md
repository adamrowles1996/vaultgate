# 05 Vault backend: managed `bw serve`

vaultgate reaches the vault through the Bitwarden CLI's Vault Management API
(`bw serve`), run as a child process that only ever listens on loopback. This
is the one supported path to a personal vault that works identically against
bitwarden.com (US and EU), self-hosted Bitwarden and Vaultwarden.

## 5.1 Process lifecycle

- **VAULT-1** `src/bitwarden/serve-process.ts` is the only module that spawns processes (ARCH-2).
  It runs `bw serve --hostname 127.0.0.1 --port <free port chosen by binding port 0 first>`
  with `BITWARDENCLI_APPDATA_DIR=${DATA_DIR}/bw` and a minimal environment (no inherited
  variables other than `PATH`, `HOME`, `TMPDIR`; vaultgate adds `BW_NOINTERACTION=true` so the
  CLI can never wait on a prompt).
- **VAULT-2** The `bw` binary path comes from `VAULTGATE_BW_BIN` (default: `bw` on `PATH`). At
  start-up vaultgate runs `bw --version`, logs it, and refuses versions below the minimum recorded
  in `src/bitwarden/versions.ts`.
- **VAULT-3** Server selection: if `VAULTGATE_BW_SERVER` is set, `bw config server <url>` is run
  before login. It accepts any `https://` URL (self-hosted / Vaultwarden) and the literal
  `bitwarden.eu`.
- **VAULT-4** Login: if `bw status` (run before `bw serve`) reports `unauthenticated`, vaultgate
  runs `bw login --apikey` with `BW_CLIENTID` and `BW_CLIENTSECRET` in the child environment only.
  Unlock: `POST /unlock` with the master password in the request body over loopback. Both
  secrets are read at start-up and kept only in process memory.
- **VAULT-5** Readiness is `true` only after `GET /status` reports `unlocked`. Until then `/readyz`
  answers `503` and MCP tool calls return a structured `vault_unavailable` error.
- **VAULT-6** If the child exits, vaultgate restarts it with exponential backoff (1 s → 60 s),
  re-unlocks, and logs each attempt. After 10 consecutive failures readiness stays `false` and
  the failure is logged at `error` level once per minute. A start-up failure (missing binary,
  rejected login or master password, `bw serve` not answering within 30 s) follows the same
  backoff; only a CLI below the minimum version (VAULT-2) stops the retry loop, since no retry
  can fix it.
- **VAULT-7** On `SIGTERM`/`SIGINT` vaultgate calls `POST /lock`, then sends `SIGTERM` to the
  child and waits up to 5 s before `SIGKILL`.
- **VAULT-8** vaultgate never calls `bw logout` and never deletes the CLI app-data directory.

## 5.2 Synchronisation

- **VAULT-9** `POST /sync` runs after unlock and then every `VAULTGATE_BW_SYNC_INTERVAL` (default
  15 minutes, minimum 1 minute). A sync failure, including the initial one, is logged and does not
  affect readiness; the cached vault continues to serve reads.
- **VAULT-10** Write tools trigger no sync; they poll `GET /object/item/<id>` every 100 ms until
  the new `revisionDate` (or, for trash, the `deletedDate`) is visible, bounded to 5 s, so a
  read-after-write is consistent. If the bound elapses the write has still succeeded, so the last
  observed item is returned rather than an error.

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
  `bw serve` rejection; each error code carries one fixed message.

## 5.5 Secret material in memory

- **VAULT-15** The master password and API secret are held in a single `Credentials` object,
  passed by reference, and zero-filled (`Buffer.fill(0)`) on shutdown. They are never
  serialised, never placed on a `Config` object that is logged, and the logger redacts the
  field names regardless (`masterPassword`, `clientSecret`).
