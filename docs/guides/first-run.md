# First run

What happens between a fresh install and a working deployment: finding the one-time setup link,
creating the operator account, enrolling an authenticator, keeping the recovery codes, and
reading `/readyz`. The rules behind each step are in spec [04 Identity](../spec/04-identity.md)
and [05 Vault backend](../spec/05-vault-backend.md).

## What start-up does

Every start follows the same order (spec §2.3.3):

1. Validate the configuration. Invalid configuration exits with status 1 and lists every
   problem, not just the first.
2. Open the SQLite database in `VAULTGATE_DATA_DIR` and apply pending migrations.
3. If no operator account exists, mint a bootstrap token and log the setup URL once.
4. Start the Bitwarden backend in the background, if it has credentials: the connection saved on
   the account page wins, otherwise the three `VAULTGATE_BW_*` seed variables when all are set.
   With credentials it checks `bw --version`, logs in with the API key if the CLI is not yet
   logged in, starts `bw serve` on a loopback port, unlocks it with the master password and runs a
   first sync; this takes a few seconds to a minute. Without any, it waits for the account page
   (step 6 below) and `/readyz` says `configured: false`.
5. Listen on `VAULTGATE_HOST:VAULTGATE_PORT`. The listener comes up before the vault is ready;
   `/readyz` reports the difference.

The log line `configuration loaded` shows every setting the process saw, with each secret
replaced by `[set]` or `[unset]`. It is the first thing to read when something is wrong.

## 1. Find the bootstrap URL

With no operator account, start-up logs exactly one line of the form:

```text
Open https://vault.example.com/setup?token=… to create the operator account
```

The link is valid for 30 minutes and for one use. It is never logged again; if it expires,
restart the service and a new one is minted. `VAULTGATE_BOOTSTRAP_TOKEN` (at least 16
characters, `_FILE` accepted) presets the token for automated installs and is ignored once an
operator exists.

Where to look depends on the install:

```bash
# Docker Compose
docker compose logs vaultgate | grep 'setup?token='

# Debian or Ubuntu (install.sh)
sudo journalctl -u vaultgate | grep 'setup?token='

# Azure Container Apps
az containerapp logs show --name vaultgate --resource-group rg-vaultgate --tail 200 \
  | grep 'setup?token='
```

Log lines are JSON; the URL is inside the `msg` field. `/setup` without a valid token shows a
generic page that does not say whether the token was wrong or expired, and once an operator
exists `/setup` answers `404` for good.

## 2. Create the operator account

Open the link over HTTPS through your reverse proxy or ingress, not on the private port. The
form asks for:

| Field                        | Rule                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| E-mail address               | The address you sign in with. It is trimmed and lower-cased; nothing is sent to it. Change it later from `/account`. |
| Password                     | 12 to 256 characters, no composition rules. Passwords on a bundled list of the 10 000 most common ones are rejected. |
| Code from your authenticator | A six-digit TOTP code from the authenticator you enrol in the next step.                                             |

There is one operator per deployment. The account is stored with an scrypt hash; the password
is never written anywhere in clear.

## 3. Enrol an authenticator

The page shows the TOTP secret two ways and no QR image:

- **Manual key**: the base32 secret, for the "enter a setup key" option in your authenticator.
- **Full URI**: an `otpauth://totp/vaultgate:<name>?secret=…&issuer=vaultgate&algorithm=SHA1&digits=6&period=30`
  line, for apps that accept a pasted URI.

Any RFC 6238 authenticator works: Bitwarden's own authenticator, Aegis, Google Authenticator,
Microsoft Authenticator, 1Password, and hardware tokens that take a base32 seed. The parameters
are the common defaults (SHA-1, six digits, 30 seconds). Enter the current code in the form and
submit.

Codes are accepted from the current 30-second step and one step either side, and a code is
never accepted twice. If your device clock is more than a minute out, the code is rejected.

## 4. Keep the recovery codes

Submitting the form creates the account and shows **eight recovery codes**, each ten characters,
exactly once. Store them where you keep other break-glass material, outside the vault this
deployment fronts. Each code signs you in once in place of an authenticator code; case, spaces
and dashes are ignored when you type one. You can generate a fresh set from the account page,
which invalidates the old set.

## 5. Sign in and the account page

Opening the bare address (`https://vault.example.com/`) takes you to the login page, or straight
to the account page when you are already signed in.

`/login` asks for the e-mail address and password, then for a six-digit authenticator code or a
recovery code. Failure messages are identical for an unknown e-mail address, a wrong password and
a wrong code. After five failures in fifteen minutes from one address or against the e-mail
address, further attempts are delayed exponentially (1 s, 2 s, 4 s, up to 60 s); there is no
permanent lockout.

An account created by a release before 0.1.0-rc.4 has no e-mail address yet. Its login page asks
for the password only; once signed in, the account page asks you to confirm your password and set
an address before anything else, and from then on login asks for e-mail address and password.

Sessions last 12 hours (`VAULTGATE_SESSION_TTL`, 15 minutes to 7 days) and expire after an hour
of inactivity. `/account` shows:

- the connected OAuth clients, each with a **Disconnect** button (once the authorization server is
  deployed, see [Connect Claude](connect-claude.md));
- your browser sessions with start time, last activity, address and browser;
- the **sensitive actions**: change e-mail address, change password (signs out every other
  session), set up a new authenticator, generate new recovery codes. Each first asks you to
  confirm your password; the confirmation lasts five minutes;
- the **vault connection** (next section).

## 6. Connect the vault

The recovery-codes page ends with a **Connect the vault** link when nothing is connected yet;
it is the **Vault connection** section of the account page. It always shows the state: whether
credentials are configured and where they came from, the server, the masked account e-mail once
`bw serve` is up, whether the vault is ready, and the last sync. To change anything, confirm your
password first (the same five-minute confirmation as the other sensitive actions), then fill in:

| Field                 | What to enter                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Server                | Leave empty for bitwarden.com. `bitwarden.eu` for the EU cloud, or the `https://` address of a self-hosted server or Vaultwarden. |
| API key client id     | `user.` followed by a UUID, from Bitwarden **Settings → Security → Keys → View API key**.                                         |
| API key client secret | From the same page. A trailing space is trimmed.                                                                                  |
| Master password       | Your Bitwarden master password, exactly as typed in Bitwarden.                                                                    |

**Save and connect** is also the test: vaultgate stores the connection (encrypted under
`VAULTGATE_SECRET_KEY`), locks and stops the running `bw serve` if there is one, logs in with the
new key in a fresh CLI app-data directory, unlocks and syncs, and only then retires the old
session. Success returns you to the section with the new status. A failure puts the previous
connection back (or leaves the vault unconfigured if there was none), shows one plain reason, and
never echoes what you typed: a rejected API key, a rejected master password, a refused server, or
`bw serve` not starting in time; the log has the detail. Secret fields are never filled in for you;
once a connection exists, leaving one blank keeps the value in use, which is how you rotate the
master password or the API key on its own without a restart.

The second way is to seed the first boot from the environment: set all three of
`VAULTGATE_BW_CLIENT_ID`, `VAULTGATE_BW_CLIENT_SECRET` and `VAULTGATE_BW_PASSWORD` (and
`VAULTGATE_BW_SERVER` if needed) before the first start, as the install guides describe. The
account page shows such a connection as _seeded from the environment_. It keeps working until you
save the form, after which the stored connection is the one that counts and the variables are
ignored; a partial set of the three is logged and ignored.

## 7. What to back up

Two things, together:

- **`VAULTGATE_SECRET_KEY`** (or the file it points at; on a Debian or Ubuntu install the `_FILE`
  secrets live in `/etc/vaultgate/secrets/`, owned by the `vaultgate` user). It encrypts the stored TOTP secret and the
  vault connection saved on the account page. Without it the database still opens and every token
  and session still works, but the authenticator cannot be verified (you would sign in with a
  recovery code and enrol a new one) and the vault connection has to be entered again.
- **The database**, `vaultgate.sqlite` in `VAULTGATE_DATA_DIR` (`/data` in the container,
  `/var/lib/vaultgate` on Linux, the Azure Files share on Azure).

The `bw/` directory next to the database is the Bitwarden CLI's cache, one numbered
subdirectory per credential generation. It is rebuilt by login and sync and needs no backup. See
[Backup and restore](backup-and-restore.md).

## 8. Read `/readyz`

Two unauthenticated probes, neither revealing a version or configuration:

| Probe      | Answer                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz` | `{"status":"ok"}` as soon as the process listens. Container health checks use it.                                                                                                |
| `/readyz`  | `{"status":"ok","vault":{"ready":true,"configured":true,"lastSyncAt":"…"}}` when everything is ready; otherwise `503` with `{"status":"unavailable","failing":[…],"vault":{…}}`. |

`failing` names the components that are not ready:

- `store`: the database is not open. This does not happen after a successful start; if you see
  it, read the log for a migration or filesystem error.
- `vault`: `bw serve` is not running and unlocked. Normal for the first seconds after start;
  persistent when something is wrong, or, with `vault.configured` `false`, simply not connected
  yet (section 6).

`vault.lastSyncAt` is the time of the last successful sync since start-up, or `null` before the
first one; a failed sync does not change `ready`.

While `vault` is failing, MCP tool calls return the error code `vault_unavailable` rather than a
result. The vault does not need to be ready for the setup, login and account pages.

### When `vault` keeps failing

The supervisor retries with exponential backoff (1 s doubling to 60 s), so the log shows what it
is retrying. Look for these lines:

| Log message                                           | Meaning                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bitwarden cli version`                               | `bw --version` worked; the version is logged.                                                                                                                                                    |
| `bitwarden cli refused`                               | The CLI is older than the minimum (2025.1.0). Retrying cannot help, so the loop stops: install a newer CLI and restart.                                                                          |
| `vault backend start failed`                          | One attempt failed; `err` says why: the binary was not found (`VAULTGATE_BW_BIN`), login was rejected (API key), unlock was rejected (master password) or `bw serve` did not answer within 30 s. |
| `bw serve is still settling; retrying unlock`         | Debug level. A freshly started `bw serve` answered `/unlock` with something other than its JSON envelope; the unlock is retried every 250 ms for up to 10 s before it counts as a failure.       |
| `vault backend unavailable`                           | The same, at `error` level after ten consecutive failures.                                                                                                                                       |
| `logging in to bitwarden with the api key`            | The CLI reported `unauthenticated`, so `bw login --apikey` runs (after `bw config server` when the connection names a server, or to reset a reused directory to the default).                    |
| `vault reconfigured` / `vault reconfiguration failed` | The account page changed the connection: the new generation is ready, or it failed (`err` says why) and the previous connection is back.                                                         |
| `initial vault sync failed`                           | Login and unlock worked but the first sync did not. Readiness is unaffected; reads serve from the cached vault and the sync is retried on the schedule.                                          |
| `vault synced`                                        | A sync succeeded; `kind` says whether it was the `initial` or a `scheduled` one and `durationMs` how long it took.                                                                               |
| `vault sync failed`                                   | A scheduled sync failed; `err` says why. Readiness is unaffected and the next sync runs on schedule.                                                                                             |
| `vault sync answered without its envelope; retrying`  | Debug level. `/sync` answered with something other than its JSON envelope while `bw serve` was still running; it is retried once after 2 s before being reported.                                |
| `vault ready`                                         | Unlocked. `/readyz` turns `200`.                                                                                                                                                                 |
| `bw serve exited`                                     | The child died; it is restarted with backoff. `code`, `signal` and `uptimeMs` say how and after how long, and `output` holds the last lines it wrote (session keys and passwords redacted).      |

Typical causes: the wrong server for an EU or self-hosted account, a client secret that was
pasted with a trailing space, a master password that has since been changed, or a Vaultwarden
account that does not yet exist. All of them are fixed from the account page's vault connection
(section 6) without a restart; rotating the master password in Bitwarden means entering the new
one there and leaving the client secret blank.

After the vault is ready it is synced every `VAULTGATE_BW_SYNC_INTERVAL` (default 15 minutes,
1 minute to 24 hours). A failed sync is logged as a warning and does not affect readiness. A
`bw serve` that dies shortly after becoming ready, for instance on every scheduled sync, counts
towards the same backoff and escalation as a failed start; only five minutes of readiness clear
the count.

## Next

Connect an agent: [Claude](connect-claude.md), [Claude Code](connect-claude-code.md),
[Codex](connect-codex.md) or the [MCP Inspector](connect-mcp-inspector.md).
