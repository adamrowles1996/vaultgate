# Security model

A plain-language summary of [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md): what an agent holding a
token can and cannot do, how long things last, and what to do when something leaks. The
threat model and the specification remain the precise statements.

## The shape of it

```text
agent ──HTTPS + bearer token──▶ vaultgate ──loopback──▶ bw serve ──HTTPS──▶ Bitwarden
                                  │   │
                                  │   └──pinned──▶ targets you defined (actions only)
                            operator browser
                        (password + TOTP, consent)
```

- The **agent** (Claude, Codex, a script) holds an access token and nothing else. It never sees
  the master password, the API key, the CLI session, or any credential an action uses.
- **vaultgate** holds the master password and API key in memory, for the life of the process
  only, and hands them to a `bw serve` child process that listens on loopback and nowhere else.
- The **operator** (you) signs in with a password and a TOTP code to approve agents and to
  revoke them. There is one operator per deployment.
- **Bitwarden** or Vaultwarden is reached over HTTPS with its own end-to-end encryption; vaultgate
  stores no vault content.
- **Targets** exist only when you enable the actions layer: the APIs, databases and hosts you
  added on the console's Connections page. vaultgate connects to them with a credential it fetches from the
  vault for that one call, and the agent receives the scrubbed result.

## What an agent can do

Only what its token's scopes allow, and the operator picks those on the consent page:

| With             | An agent can                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault:read`     | Search and list items, folders and collections; see names, usernames, URIs, dates and which secret fields exist.                                                                                                                               |
| `vault:reveal`   | Read one secret field of one item per call, each call audited.                                                                                                                                                                                 |
| `vault:generate` | Get a random password or passphrase.                                                                                                                                                                                                           |
| `vault:write`    | Create logins, secure notes and folders; change item fields; move items to the trash. Off unless the deployment enables it.                                                                                                                    |
| `actions:*`      | Use a credential at a target you defined (an HTTP API, a database, an SSH or WinRM host), for the operations your policy allows, without ever receiving it. Absent unless the deployment enables the actions layer; see [Actions](actions.md). |

## What an agent cannot do

- **Hold credentials.** Tokens are opaque random strings; vaultgate stores only their hashes and
  accepts nothing it did not issue. A token cannot be turned into the master password or the API
  key, and vaultgate never forwards a bearer token anywhere.
- **Read secrets in bulk.** Search returns at most 50 summaries with no secret values. Each secret
  is a separate, audited `get_secret` call for one field, and a token may make 120 calls a minute.
- **Read a TOTP seed.** Only the current code is returned.
- **Delete permanently.** `trash_item` moves items to the trash, where you can restore them.
- **Run anything.** There is no tool that executes a command of the agent's choosing, reads a file
  or fetches a URL. The actions layer runs typed operations only at targets you defined, under your
  allowlists, and nothing ever executes on the vaultgate host.
- **See a credential it uses.** Every value an action injects is scrubbed from the result, the
  errors and the audit trail before anything leaves the engine.
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
| Consent               | Until you disconnect the client on the Agents page.                                                                                                           |
| Operator session      | 12 hours (`VAULTGATE_SESSION_TTL`, 15 minutes to 7 days), 1 hour idle. Signing out or changing the password ends sessions.                                    |
| Password confirmation | 5 minutes, for the sensitive actions and every change to a connection.                                                                                        |
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
- Tool results travel to the agent over HTTPS: metadata, for `get_secret` one secret value, and for
  an action its scrubbed result.
- With the actions layer enabled, vaultgate connects to the targets you defined, and for a
  Microsoft Graph target to the Microsoft sign-in endpoint, over pinned connections.
- Nothing is sent to the vaultgate project or anyone else. There is no telemetry.
- When a client registers with a Client ID Metadata Document, vaultgate fetches that HTTPS
  document once and caches it, through a fetcher that refuses private addresses.

## If something leaks

| Leaked                        | Do this                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An access or refresh token    | Agents → **Disconnect** the client. That revokes the consent and every token in it. Reconnect the client afterwards if it is legitimate.                                                      |
| Your operator password        | Account & security → confirm password → **Change password**. Every other session is signed out. Then regenerate recovery codes.                                                               |
| `VAULTGATE_SECRET_KEY`        | Set a new key and restart. Tokens are unaffected; sign in with a recovery code and set up a new authenticator ([Backup and restore](backup-and-restore.md#if-the-key-is-lost)).               |
| The Bitwarden master password | Change it in Bitwarden, then on the Vault page enter the new one under **Vault connection** (leave the client secret blank) and save. No restart.                                             |
| The Bitwarden API key         | Rotate it in the web vault (Settings → Security → Keys), then enter the new client id and secret on the Vault page (leave the master password blank) and save. The CLI session is replaced.   |
| The host itself               | Stop the service (which locks the vault), rotate the API key and master password in Bitwarden and the credential of every action target, export and review the audit trail, rebuild the host. |

Every tool call, login, consent, token issue, refresh and revocation is an audit event in the
database, exported from the Activity page or with `node dist/cli.js audit export` (see the
[FAQ](faq.md#where-is-the-audit-log)), so after any of the above you can see exactly which items
and fields were touched, by which client, from which address.

## Accepted residual risks

- Anyone with root on the host can read the process memory and therefore the master password.
  Run nothing else on the host or in the container.
- `bw serve` has no authentication of its own; loopback binding and network-namespace isolation
  are the controls. Running the container with `--network host` is unsupported.
- How a hosted agent product stores its tokens is outside this model; short access-token life
  and revocation limit the blast radius.
