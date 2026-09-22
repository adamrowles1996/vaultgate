# 09 Deployment

Three supported ways to run vaultgate, all producing the same process with the
same configuration surface. TLS termination is always in front of vaultgate
(reverse proxy or platform ingress); vaultgate itself speaks plain HTTP on a
private interface.

## 9.1 Container image (primary)

- **DEP-1** `ghcr.io/adamrowles1996/vaultgate:<semver>` and `:latest`, built by the release
  workflow for `linux/amd64` and `linux/arm64`, signed with Sigstore cosign (keyless), with an SPDX
  SBOM attached and a provenance attestation.
- **DEP-2** Base image `node:26-bookworm-slim` pinned by digest (Debian rather than Alpine: the
  Bitwarden CLI binary is linked against glibc); the CLI is installed from the official GitHub
  release zip pinned by version and SHA-256 for each architecture in the Dockerfile. Multi-stage:
  `npm ci`, `npm run build`, `npm prune --omit=dev`, then a runtime stage holding only `dist`,
  production `node_modules`, `package.json` and the CLI, with a non-root user `vaultgate`
  (uid and gid 10001), a `/data` volume, a curl-free `HEALTHCHECK` on `/healthz` and
  `ENTRYPOINT ["node","dist/main.js"]`. The image writes only under `/data` and `/tmp`, so the
  deployment runs it with a read-only root filesystem (`read_only: true` in Compose).
- **DEP-3** `docker-compose.yml` runs vaultgate plus Caddy for automatic TLS, with an `.env`
  driven configuration and secrets mounted as files. `docker compose up -d` from a clone is a
  complete installation for a single VM.

## 9.2 Bare Linux (`install.sh`)

- **DEP-4** `curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash`
  is supported but the script is written to be read first: it prints every step, verifies the
  release tarball checksum, creates a system user, installs to `/opt/vaultgate`, writes
  `/etc/vaultgate/vaultgate.env` (mode 0600), and installs a hardened systemd unit
  (`DynamicUser=no`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`,
  `NoNewPrivileges=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
  `SystemCallFilter=@system-service`, `ReadWritePaths=/var/lib/vaultgate`).
- **DEP-5** The script requires Node 26 and the Bitwarden CLI and offers to install both from
  official sources with checksum verification; it never uses a distribution package of unknown
  provenance silently.

## 9.3 Azure Container App (ARM)

- **DEP-6** `deploy/azure/mainTemplate.json` provisions: a resource group scope deployment with a
  Log Analytics workspace, a Container Apps environment, a Key Vault (RBAC mode, purge protection),
  a storage account with an Azure Files share mounted at `/data`, and the Container App with a
  system-assigned managed identity holding **Key Vault Secrets User** on the vault. Secrets are
  referenced by the app as Key Vault secret references, never as plain environment values.
- **DEP-7** The template parameters are: `name`, `location`, `imageTag`, `publicUrl` (optional
  custom domain), `bitwardenServer` (optional), and the secret values (`bwPassword`, `bwClientId`,
  `bwClientSecret`, `secretKey`) marked `securestring`. A `createUiDefinition.json` powers the
  "Deploy to Azure" button.
- **DEP-8** `maxReplicas` is `1` and `VAULTGATE_SQLITE_NETWORK_FS=true` is set, because SQLite
  on an SMB share is safe only with one writer and rollback-journal mode (STORE-2).
- **DEP-9** Ingress is external, HTTPS only, target port 8080, `VAULTGATE_TRUST_PROXY=true`.
  The template's README documents adding a custom domain and managed certificate.
- **DEP-10** CI validates the template with `az bicep`-independent tooling: ARM-TTK on every PR
  touching `deploy/azure/**`, and a `what-if` deployment against a sandbox subscription on release
  candidates (manual approval environment).

## 9.4 Reverse proxy requirements

- **DEP-11** The proxy MUST forward `Host` unchanged or set `X-Forwarded-Host`, set
  `X-Forwarded-Proto: https`, and pass through the `Authorization` header and `WWW-Authenticate`
  response header. Example Caddy and nginx snippets are shipped in `deploy/proxy/`.
- **DEP-12** The proxy SHOULD not buffer responses for `/mcp` (SSE-capable), with read timeouts
  of at least 60 s.
