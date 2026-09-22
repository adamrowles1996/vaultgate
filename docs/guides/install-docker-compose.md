# Install with Docker Compose

The reference single-VM installation (spec [DEP-3](../spec/09-deployment.md)): the
vaultgate image behind [Caddy](https://caddyserver.com), which obtains and renews the TLS
certificate. You need a VM with Docker Engine and the Compose plugin, a DNS name pointing at
it, and ports 80 and 443 reachable from the internet (hosted agents connect from outside).

## 1. Clone and configure

```bash
git clone https://github.com/adamrowles1996/vaultgate.git
cd vaultgate
cp .env.example .env
```

Edit `.env`:

- `VAULTGATE_DOMAIN`: the hostname Caddy serves, for example `vault.example.com`.
- `VAULTGATE_PUBLIC_URL`: `https://` followed by that same hostname.
- `VAULTGATE_BW_CLIENT_ID`: the `user.…` client id of your Bitwarden personal API key.
- `VAULTGATE_VERSION`: a release such as `0.1.0`, or `latest`.
- `VAULTGATE_BW_SERVER` only for bitwarden.eu, a self-hosted server or Vaultwarden.

Leave the remaining lines alone. The Compose file fixes the bind address, port, data directory
and proxy trust inside the container, and the secret files below take precedence over the
placeholder values (`*_FILE` always wins).

## 2. Secrets as files

```bash
mkdir -p secrets
head -c 32 /dev/urandom | base64 > secrets/vaultgate_secret_key
printf '%s' 'your master password' > secrets/bw_password
printf '%s' 'your API key client secret' > secrets/bw_client_secret
chmod 0400 secrets/* && sudo chown 10001 secrets/*
```

The container runs as uid 10001, so each file must be readable by that user and nobody else; a
world-readable secret file is reported at start-up (spec CFG-1). Back up
`secrets/vaultgate_secret_key` with the data volume: without it the TOTP secrets in the database
cannot be decrypted.

## 3. Start

```bash
docker compose up -d
docker compose logs -f vaultgate
```

The first start logs the bootstrap URL; open it to create the operator account.
`docker compose ps` reports `healthy` once `/healthz` answers, and
`curl -fsS https://vault.example.com/healthz` should return `{"status":"ok"}`.

## What the Compose file enforces

- Read-only root filesystem, `tmpfs` on `/tmp`, every capability dropped, `no-new-privileges`.
- Port 8080 is not published; only Caddy, on the Compose network, reaches vaultgate.
- Caddy is pinned by tag and digest and keeps all capabilities but `NET_BIND_SERVICE`.
- State lives in the `vaultgate-data` volume (SQLite database and Bitwarden CLI app data).

## Upgrading

Set `VAULTGATE_VERSION` in `.env`, then `docker compose pull && docker compose up -d`.
Migrations run automatically and are forward-only (spec OPS-7); a major version documents
its upgrade in `CHANGELOG.md`.

## Verifying the image

Every release image is signed keyless with Sigstore and carries a provenance attestation:

```bash
cosign verify ghcr.io/adamrowles1996/vaultgate:<version> \
  --certificate-identity-regexp '^https://github.com/adamrowles1996/vaultgate/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/adamrowles1996/vaultgate:<version> --owner adamrowles1996
```
