# Upgrading

Releases follow semantic versioning. Patch and minor upgrades are in place: put the new version
in, restart, done. Database migrations run automatically at start-up and are forward-only. A
major version documents anything more under an **Upgrading** heading in
[`CHANGELOG.md`](../../CHANGELOG.md); read it before moving across a major boundary.
Specification: [10 § 10.5](../spec/10-operations.md) and [07 § 7.1](../spec/07-storage.md).

Take a [backup](backup-and-restore.md) first. It is the only way back once a migration has run.

## Docker Compose

```bash
# in the clone that holds docker-compose.yml and .env
sed -i 's/^VAULTGATE_VERSION=.*/VAULTGATE_VERSION=1.2.3/' .env
docker compose pull
docker compose up -d
docker compose logs -f vaultgate
```

`VAULTGATE_VERSION=latest` follows the newest release on every `pull`; pin a version for
anything you would mind being surprised by. Every image is signed; verifying it before pulling is
described in [Install with Docker Compose](install-docker-compose.md#verifying-the-image).

The image carries its own pinned Bitwarden CLI, so a release that raises the CLI version brings
it along. Caddy is pinned by digest in `docker-compose.yml`; pull the repository to pick up a
newer pin.

## Debian or Ubuntu

Re-run the installer, with or without `--version`:

```bash
curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash
curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash -s -- --version 1.2.3
```

The script downloads and verifies the release tarball, installs it to `/opt/vaultgate/<version>`,
moves the `current` symlink and restarts the service. `/etc/vaultgate/vaultgate.env` is never
overwritten. The installer also updates the Bitwarden CLI when the release pins a newer one; the
process refuses to start with a CLI below its minimum, so a CLI you manage yourself must keep up.

## Azure Container Apps

Redeploy the template with a new `imageTag` and the same secrets, or update the image directly:

```bash
az containerapp update --name vaultgate --resource-group rg-vaultgate \
  --image ghcr.io/adamrowles1996/vaultgate:1.2.3
```

The single replica restarts on the new revision; migrations run on that start. `imageTag=latest`
only changes when a revision restarts, so pin a version there too.

## What to check afterwards

```bash
curl -fsS https://vault.example.com/healthz
curl -fsS https://vault.example.com/readyz
```

and, in the log, `configuration loaded` (the settings the new version saw), `bitwarden cli
version`, and `vault ready`. Then make one tool call from any connected client; tokens and
consents survive an upgrade, so nothing needs reconnecting.

## Rolling back

Within a major version, run the previous release again:

- Compose: set the previous `VAULTGATE_VERSION` and `docker compose up -d`.
- Linux: `sudo ln -sfn /opt/vaultgate/<previous> /opt/vaultgate/current && sudo systemctl restart vaultgate`.
- Azure: `az containerapp update … --image …:<previous>`.

This works as long as the newer version applied no migration. Migrations are forward-only and
each applied one is recorded with a checksum; an older build that finds an applied migration it
does not know refuses to start, as does any build that finds a database written by a newer major
version. In that case restore the pre-upgrade database from your backup and then start the
previous release.

## Keeping current

Watch the repository's releases (GitHub → Watch → Custom → Releases). Security fixes are
announced there and described in `CHANGELOG.md`; `SECURITY.md` explains how they are reported.
