# Backup and restore

vaultgate's state is one SQLite file plus one key. Specification:
[07 § 7.4 Backup and restore](../spec/07-storage.md).

## What to back up

| Item                   | Where                                                                                                              | Why                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `vaultgate.sqlite`     | `VAULTGATE_DATA_DIR`: `/data` in the container, `/var/lib/vaultgate` on Linux, the `vaultgate-data` share on Azure | The operator account, the enrolled authenticator, recovery codes, OAuth clients, consents, tokens and the audit trail. |
| `VAULTGATE_SECRET_KEY` | `secrets/vaultgate_secret_key` (Compose), `/etc/vaultgate/vaultgate.env` (Linux), Key Vault `secret-key` (Azure)   | Encrypts the stored TOTP secret and keys session binding. Without it the authenticator cannot be verified.             |

Back them up together and keep the key outside the backup of the database if you can, since the
two together are what an attacker would need to impersonate the operator (they still would not
have the vault: that needs the master password, which is not stored anywhere).

What you do **not** need:

- The `bw/` directory next to the database. It is the Bitwarden CLI's cache of the encrypted
  vault and its session; it is rebuilt by login and sync on the next start.
- The Bitwarden vault itself. vaultgate stores no vault content, ever. Your vault's backup is
  Bitwarden's or Vaultwarden's own concern.
- The configuration file, beyond the key. Everything else in it is easy to recreate, but backing
  it up costs nothing.

The database contains no raw secret: passwords are scrypt hashes, tokens, codes and session ids
are SHA-256 hashes, the TOTP secret is AES-256-GCM ciphertext under the key. A backup is still
sensitive, because a token hash plus the ability to write the database is enough to mint access.

## Taking a backup

The database runs in WAL mode, so copying the bare file while the process is running is not
safe. Either use SQLite's online backup while running, or copy the file while stopped.

### Docker Compose

The image has no `sqlite3` binary, so stop the service for the copy (a few seconds; agents get
`vault_unavailable` meanwhile):

```bash
docker compose stop vaultgate
docker run --rm -v vaultgate-data:/data -v "$PWD/backups:/backups" alpine \
  sh -c 'cp /data/vaultgate.sqlite* /backups/'
docker compose start vaultgate
cp secrets/vaultgate_secret_key backups/
```

Copying `vaultgate.sqlite*` picks up the `-wal` and `-shm` files if they exist; after a clean
stop they normally do not.

### Debian or Ubuntu

`sqlite3` (package `sqlite3`) can back up the live database consistently:

```bash
sudo sqlite3 /var/lib/vaultgate/vaultgate.sqlite ".backup '/root/vaultgate-backup.sqlite'"
sudo grep VAULTGATE_SECRET_KEY /etc/vaultgate/vaultgate.env > /root/vaultgate-secret-key.env
sudo chmod 0600 /root/vaultgate-backup.sqlite /root/vaultgate-secret-key.env
```

### Azure Container Apps

The database lives on the `vaultgate-data` Azure Files share; snapshot it, and read the key from
Key Vault (it is `secret-key`; the deployment's Key Vault name ends in a hash):

```bash
az storage share snapshot --account-name <storage account> --name vaultgate-data
az keyvault secret show --vault-name <key vault> --name secret-key --query value -o tsv
```

A share snapshot taken while the app is running is crash-consistent, which SQLite in rollback
journal mode (what `VAULTGATE_SQLITE_NETWORK_FS=true` selects) recovers from; for a clean copy,
scale the app to zero first and back to one afterwards.

## Restoring

1. Stop vaultgate.
2. Put `vaultgate.sqlite` back in `VAULTGATE_DATA_DIR`, remove any stale `vaultgate.sqlite-wal`
   and `vaultgate.sqlite-shm` next to it, and make it readable and writable by the service user
   only (uid 10001 in the container, `vaultgate` on Linux; mode `0600`).
3. Set `VAULTGATE_SECRET_KEY` to the value that was in use when the backup was taken.
4. Start vaultgate. Migrations newer than the backup are applied automatically; a backup written
   by a newer major version than the software you start is refused (see [Upgrading](upgrading.md)).

Everything in the database restores as it was: the operator signs in with the same password and
authenticator, connected clients keep working until their tokens expire, and the audit trail is
intact up to the backup.

## If the key is lost

Start with the database and a new `VAULTGATE_SECRET_KEY` (at least 32 random bytes, base64 or
hex). The store opens, OAuth tokens and clients are unaffected, but the TOTP secret cannot be
decrypted:

1. Sign in with your e-mail address, password and a **recovery code** (they are hashes, not
   ciphertext, so they still work).
2. On the account page confirm your password, then **Set up a new authenticator**.
3. **Generate new recovery codes** while you are there.

Rotating the key deliberately follows the same steps; nothing else needs to change.

## If the database is lost

Without the database there is no operator account, so start-up logs a fresh bootstrap URL
(see [First run](first-run.md)). Every OAuth client and consent is gone; each agent has to be
connected again. The vault is untouched: vaultgate never held it.

## Retention

A maintenance task runs hourly and deletes expired codes, sessions and bootstrap tokens, tokens
revoked or expired more than seven days ago, login attempts older than a day and audit events
older than `VAULTGATE_AUDIT_RETENTION_DAYS` (default 365, 1 to 3650). Keep backups for as long
as you want an audit history that outlives that window.
