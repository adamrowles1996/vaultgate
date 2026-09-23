# Install on Debian or Ubuntu with `install.sh`

The bare-Linux installation (spec [DEP-4 and DEP-5](../spec/09-deployment.md)). The script
creates a system user, installs each release to `/opt/vaultgate/<version>` behind a `current`
symlink, writes `/etc/vaultgate/vaultgate.env` (root, mode 0600), creates
`/etc/vaultgate/secrets` for file-based secrets, keeps state in `/var/lib/vaultgate` and runs the
service under a hardened systemd unit. Node 26 and the Bitwarden CLI come from their official
release archives with SHA-256 verification; apt installs only `curl`, `ca-certificates`, `unzip`,
`xz-utils` and `libatomic1` (Node 26 needs it and Ubuntu 24.04 cloud images ship without it).
Other distributions are refused; use the [Compose install](install-docker-compose.md) there.

Read [`install.sh`](../../install.sh) before running it. It prints every step.

## 1. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash
```

Add `-s -- --version 0.1.0` after `bash` to pick a release; the default is the latest. The
script downloads `vaultgate-<version>.tgz` and `vaultgate-<version>.tgz.sha256` from the GitHub
release and verifies the tarball before unpacking it.

## 2. Configure

```bash
sudoedit /etc/vaultgate/vaultgate.env
```

Set `VAULTGATE_PUBLIC_URL` and the three `VAULTGATE_BW_*` values (master password and personal
API key). `VAULTGATE_SECRET_KEY` is already generated; back it up together with
`/var/lib/vaultgate`. The full reference is [spec 08](../spec/08-configuration.md).

To keep the secrets out of the environment file, write each one to `/etc/vaultgate/secrets/` and
point the matching `<NAME>_FILE` variable at it. The service reads those files as the `vaultgate`
user (not as root), so each file must belong to that user and to nobody else; `install` sets the
owner and mode in one step and reads the value from standard input, so it never lands in your
shell history:

```bash
sudo install -m 0600 -o vaultgate -g vaultgate /dev/stdin /etc/vaultgate/secrets/bw_password
sudo install -m 0600 -o vaultgate -g vaultgate /dev/stdin /etc/vaultgate/secrets/bw_client_secret
```

Type the value, press Enter, then Ctrl-D. In `vaultgate.env` replace the two secret lines with
`VAULTGATE_BW_PASSWORD_FILE=/etc/vaultgate/secrets/bw_password` and
`VAULTGATE_BW_CLIENT_SECRET_FILE=/etc/vaultgate/secrets/bw_client_secret`. A `_FILE` variable
always wins over the plain one, and a world-readable secret file is reported as a warning at
start-up. `VAULTGATE_BW_CLIENT_ID` is not a secret and has no `_FILE` form.

## 3. Put a reverse proxy in front

vaultgate listens on `127.0.0.1:8080`. Terminate TLS with Caddy or nginx as described in
[`reverse-proxy.md`](reverse-proxy.md); the snippets are also in
`/opt/vaultgate/current/deploy/proxy/`.

## 4. Start and bootstrap

```bash
sudo systemctl start vaultgate
sudo journalctl -u vaultgate -n 50
```

The log contains the first-run bootstrap URL; open it to create the operator account.

## Layout

| Path                                    | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `/opt/vaultgate/<version>`              | One release: `dist`, `node_modules`, `deploy`        |
| `/opt/vaultgate/current`                | Symlink to the active release                        |
| `/etc/vaultgate/vaultgate.env`          | Configuration, root-only, never overwritten          |
| `/etc/vaultgate/secrets/`               | `<NAME>_FILE` secrets, owner `vaultgate`, mode 0700  |
| `/var/lib/vaultgate`                    | SQLite database and Bitwarden CLI app data           |
| `/usr/local/bin/node`                   | Node 26 from nodejs.org (or your existing Node ≥ 26) |
| `/usr/local/bin/bw`                     | Bitwarden CLI, version pinned in the script          |
| `/etc/systemd/system/vaultgate.service` | The unit from `deploy/systemd/`                      |

## Upgrading and rolling back

Re-run the installer, with or without `--version`. The configuration file and the secrets
directory are kept, `current` moves to the new release and the service restarts. To roll back within a major version:
`sudo ln -sfn /opt/vaultgate/<previous> /opt/vaultgate/current && sudo systemctl restart vaultgate`.
Database migrations are forward-only, so a major version cannot be rolled back this way.

## Hardening

The unit runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, an empty capability set, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
`SystemCallFilter=@system-service` and `ReadWritePaths=/var/lib/vaultgate` only. Inspect the
result with `systemd-analyze security vaultgate`.
