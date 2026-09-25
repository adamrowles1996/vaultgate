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

Download the script, read it, then run it:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh
less install.sh
sudo bash install.sh
```

The piped one-liner does the same in one step, once you trust the script:

```bash
curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash
```

Add `--version 0.1.0` after `install.sh` (or `-s -- --version 0.1.0` after `bash` in the piped
form) to pick a release; the default is the latest. The script downloads `vaultgate-<version>.tgz`
and `vaultgate-<version>.tgz.sha256` from the GitHub release and verifies the tarball before
unpacking it.

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

Type the value, press Enter, then Ctrl-D. In `vaultgate.env` add
`VAULTGATE_BW_PASSWORD_FILE=/etc/vaultgate/secrets/bw_password`,
`VAULTGATE_BW_CLIENT_SECRET_FILE=/etc/vaultgate/secrets/bw_client_secret` and
`VAULTGATE_BW_CLIENT_ID=user.…`. A `_FILE` variable always wins over the plain one, and a
world-readable secret file is reported as a warning at start-up. `VAULTGATE_BW_CLIENT_ID` is not
a secret and has no `_FILE` form.

This seeding is optional. The usual way is to leave the three Bitwarden lines commented out,
start the service, create the operator account, and connect the vault on the console's Vault page
([First run, section 6](first-run.md#6-connect-the-vault)); the connection is stored encrypted
in the database and takes effect without a restart. Once saved there, the environment values are
ignored.

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

## 5. The code search sidecar (optional)

The [code connector](code-search.md) (Semble code search over GitHub repositories) needs its
sidecar. Add `--with-code-sidecar` to the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash -s -- --with-code-sidecar
```

It downloads `vaultgate-code-<version>.tgz` from the same release and verifies it against its
`.sha256`, creates the system user `vaultgate-code`, installs the Python dependencies from the
release's hash-locked `requirements.txt` (wheels only) into a virtual environment, downloads the
embedding model at its pinned revision and checks every file against the SHA-256 in `model.json`,
and runs the sidecar as `vaultgate-code.service` on the Unix socket
`/run/vaultgate-code/code.sock`, which only the `vaultgate-code` group may open. The `vaultgate`
user is added to that group, and `/etc/vaultgate/vaultgate.env` gains
`VAULTGATE_ACTIONS_ENABLE_CODE=true` and `VAULTGATE_ACTIONS_CODE_URL=unix:/run/vaultgate-code/code.sock`
when they are not set yet; nothing else in the file changes. The connector also needs the actions
layer itself, `VAULTGATE_ENABLE_ACTIONS=true`. It needs Python 3.12 (Ubuntu 24.04 has it; apt adds
`python3.12-venv` when it is missing) and about 1 GB of free memory for the model, a build and
the loaded indexes.

The sidecar's unit has no network interface but a loopback of its own
(`PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`) and systemd's other
sandboxing, so it can reach neither the internet nor `bw serve`; vaultgate fetches each
repository itself and streams it in (spec [ACT-114](../spec/14a-code-connector.md)). Its limits
are commented out in `/etc/vaultgate/vaultgate-code.env`. Once installed, every re-run of the
installer upgrades the sidecar with the core, since the two speak one protocol version.

```bash
sudo systemctl status vaultgate-code
sudo journalctl -u vaultgate-code -n 50
systemd-analyze security vaultgate-code
```

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

With `--with-code-sidecar`:

| Path                                         | Purpose                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `/opt/vaultgate-code/<version>`              | The sidecar: `app`, its `venv` and the verified `model`           |
| `/opt/vaultgate-code/current`                | Symlink to the active sidecar release                             |
| `/etc/vaultgate/vaultgate-code.env`          | The sidecar's limits (optional), never overwritten                |
| `/var/lib/vaultgate-code`                    | Snapshots and indexes; losing it costs only the time to rebuild   |
| `/run/vaultgate-code/code.sock`              | The socket vaultgate reaches it on (group `vaultgate-code`, 0660) |
| `/etc/systemd/system/vaultgate-code.service` | The unit from `deploy/systemd/`                                   |

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
