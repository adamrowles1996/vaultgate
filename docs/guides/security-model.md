# Security model

A plain-language summary of [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md): what an agent holding a
token can and cannot do, how long things last, and what to do when something leaks. The
threat model and the specification remain the precise statements.

## The shape of it

```text
agent ──HTTPS + bearer token──▶ vaultgate ──loopback──▶ bw serve ──HTTPS──▶ Bitwarden
                                    │
                            operator browser
                        (password + TOTP, consent)
```

- The **agent** (Claude, Codex, a script) holds an access token and nothing else. It never sees
  the master password, the API key, or the CLI session.
- **vaultgate** holds the master password and API key in memory, for the life of the process
  only, and hands them to a `bw serve` child process that listens on loopback and nowhere else.
- The **operator** (you) signs in with a password and a TOTP code to approve agents and to
  revoke them. There is one operator per deployment.
- **Bitwarden** or Vaultwarden is reached over HTTPS with its own end-to-end encryption; vaultgate
  stores no vault content.

## What an agent can do

Only what its token's scopes allow, and the operator picks those on the consent page:

| With             | An agent can                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `vault:read`     | Search and list items, folders and collections; see names, usernames, URIs, dates and which secret fields exist.            |
| `vault:reveal`   | Read one secret field of one item per call, each call audited.                                                              |
| `vault:generate` | Get a random password or passphrase.                                                                                        |
| `vault:write`    | Create logins, secure notes and folders; change item fields; move items to the trash. Off unless the deployment enables it. |

## What an agent cannot do

- **Hold credentials.** Tokens are opaque random strings; vaultgate stores only their hashes and
  accepts nothing it did not issue. A token cannot be turned into the master password or the API
  key, and vaultgate never forwards a bearer token anywhere.
- **Read secrets in bulk.** Search returns at most 50 summaries with no secret values. Each secret
  is a separate, audited `get_secret` call for one field, and a token may make 120 calls a minute.
- **Read a TOTP seed.** Only the current code is returned.
- **Delete permanently.** `trash_item` moves items to the trash, where you can restore them.
- **Run anything.** There is no tool that executes a command, reads a file or fetches a URL.
- **Use a token from somewhere else.** Tokens are bound to this deployment's `/mcp` resource and
  to the scopes granted; a token issued for another server is rejected, and scopes cannot be
  widened on refresh.
- **See tools it cannot use.** `tools/list` is filtered by the token's scopes.
- **Reach `bw serve`.** It listens on loopback inside the host or container; nothing on the
  network can talk to it.

## Lifetimes

| Thing                 | Lifetime                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization code    | 5 minutes, single use. Reuse revokes every token issued from it.                                                                                              |
| Access token          | 1 hour (`VAULTGATE_ACCESS_TOKEN_TTL`, 5 minutes to 24 hours).                                                                                                 |
| Refresh token         | 30 days absolute (`VAULTGATE_REFRESH_TOKEN_TTL`, 1 hour to 365 days), single use, rotated on each refresh. A replayed refresh token revokes the whole family. |
| Consent               | Until you disconnect the client on the account page.                                                                                                          |
| Operator session      | 12 hours (`VAULTGATE_SESSION_TTL`, 15 minutes to 7 days), 1 hour idle. Signing out or changing the password ends sessions.                                    |
| Password confirmation | 5 minutes, for the sensitive actions on the account page.                                                                                                     |
| Bootstrap token       | 30 minutes, single use; only exists while there is no operator.                                                                                               |
| Audit events          | 365 days (`VAULTGATE_AUDIT_RETENTION_DAYS`, 1 to 3650).                                                                                                       |

## How the operator is protected

- The password is stored as an scrypt hash; the TOTP secret is encrypted under
  `VAULTGATE_SECRET_KEY`; recovery codes and session ids are stored as hashes.
- Login failures are answered identically whatever went wrong, and are slowed exponentially
  after five failures in fifteen minutes, without a lockout that an attacker could use to deny
  you access.
- A TOTP code is never accepted twice.
- Sensitive actions (revoking a client, changing the password, rotating the authenticator,
  regenerating recovery codes) require your password again within the last five minutes.
- The pages contain no JavaScript and run under a strict Content Security Policy; every form is
  protected by a same-site cookie, an `Origin` check and a per-session token.
- The consent page shows who is asking, where the code will be sent, how the client registered,
  and warns when the redirect is a loopback address, so a phishing client is visible for what it
  is.

## What leaves your network

- Vault data travels between `bw serve` and your Bitwarden server, encrypted end to end by
  Bitwarden's own protocol, exactly as the official clients do.
- Tool results travel to the agent over HTTPS: metadata, and for `get_secret`, one secret value.
- Nothing is sent to the vaultgate project or anyone else. There is no telemetry.
- When a client registers with a Client ID Metadata Document, vaultgate fetches that HTTPS
  document once and caches it, through a fetcher that refuses private addresses.

## If something leaks

| Leaked                        | Do this                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An access or refresh token    | Account page → **Disconnect** the client. That revokes the consent and every token in it. Reconnect the client afterwards if it is legitimate.                                  |
| Your operator password        | Account page → confirm password → **Change password**. Every other session is signed out. Then regenerate recovery codes.                                                       |
| `VAULTGATE_SECRET_KEY`        | Set a new key and restart. Tokens are unaffected; sign in with a recovery code and set up a new authenticator ([Backup and restore](backup-and-restore.md#if-the-key-is-lost)). |
| The Bitwarden master password | Change it in Bitwarden, update `VAULTGATE_BW_PASSWORD` (or its file), restart.                                                                                                  |
| The Bitwarden API key         | Rotate it in the web vault (Settings → Security → Keys), update the configuration, delete the CLI app data under `VAULTGATE_DATA_DIR/bw`, restart.                              |
| The host itself               | Stop the service (which locks the vault), rotate the API key and master password in Bitwarden, review the audit events in the log, rebuild the host.                            |

Every tool call, login, consent, token issue, refresh and revocation is an audit event in the
log (`audit event` lines, JSON), so after any of the above you can see exactly which items and
fields were touched, by which client, from which address.

## Accepted residual risks

- Anyone with root on the host can read the process memory and therefore the master password.
  Run nothing else on the host or in the container.
- `bw serve` has no authentication of its own; loopback binding and network-namespace isolation
  are the controls. Running the container with `--network host` is unsupported.
- How a hosted agent product stores its tokens is outside this model; short access-token life
  and revocation limit the blast radius.
