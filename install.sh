#!/usr/bin/env bash
# vaultgate installer for Debian and Ubuntu (docs/spec/09-deployment.md, DEP-4 and DEP-5).
#
# Read it before you run it; every step is printed. Node 26 and the Bitwarden
# CLI come from their official release archives with SHA-256 verification (no
# distribution package of either is installed), the vaultgate release tarball
# is verified against the checksum published beside it, and the service runs
# as its own system user under a hardened systemd unit.
#
#   curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/adamrowles1996/vaultgate/main/install.sh | sudo bash -s -- --version 0.1.0
#
# Re-running upgrades in place. An existing /etc/vaultgate/vaultgate.env is never overwritten.
# scripts/test-install-sh.sh sources this file (the guard at the end keeps main
# from running) to check the argument and operating-system logic.
set -euo pipefail

REPO="adamrowles1996/vaultgate"
INSTALL_ROOT="/opt/vaultgate"
CONFIG_DIR="/etc/vaultgate"
DATA_DIR="/var/lib/vaultgate"
SERVICE_USER="vaultgate"
NODE_MAJOR=26
VERSION="${VAULTGATE_VERSION:-}"
OS_RELEASE_FILE="${OS_RELEASE_FILE:-/etc/os-release}"

# Bitwarden CLI pin. Keep equal to the Dockerfile; src/bitwarden/versions.test.ts checks it (COMPAT-1).
# The release publishes no checksum file; these digests were computed from the assets.
BW_VERSION="2026.9.0"
BW_SHA256_AMD64="580c1deec8345b19dbac7f8b02babb6cc4fe250c69c567e29061f727f1e40768"
BW_SHA256_ARM64="3f474cc34b701a1cebdd486009870038b034343afb83095607422cdad4c3653a"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

parse_arguments() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a value"
        VERSION="$2"
        shift 2
        ;;
      -h | --help)
        echo "usage: install.sh [--version X.Y.Z]   (VAULTGATE_VERSION=X.Y.Z also works)"
        exit 0
        ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo); the installer writes to /opt, /etc and /var/lib"
}

# One field of os-release, unquoted. The file is never sourced: it defines
# VERSION on every Debian and Ubuntu, which would silently replace ours.
os_release_field() {
  sed -n "/^$1=/{s/^$1=//;p;q;}" "$OS_RELEASE_FILE" | tr -d "\"'"
}

require_debian_family() {
  step "Checking the operating system"
  [ -r "$OS_RELEASE_FILE" ] || die "cannot read ${OS_RELEASE_FILE}"
  local os_id os_like pretty
  os_id=$(os_release_field ID)
  os_like=$(os_release_field ID_LIKE)
  pretty=$(os_release_field PRETTY_NAME)
  case " ${os_id} ${os_like} " in
    *" debian "* | *" ubuntu "*) info "${pretty:-$os_id} is supported" ;;
    *)
      die "this installer supports Debian and Ubuntu only (found ${pretty:-${os_id:-unknown}}). " \
        "On other systems, use the container image: docs/guides/install-docker-compose.md"
      ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in
    amd64 | arm64) info "architecture ${ARCH}" ;;
    *) die "unsupported architecture ${ARCH}; amd64 and arm64 are supported" ;;
  esac
}

# True when the dynamic linker knows the named shared library.
has_shared_library() {
  ldconfig -p 2>/dev/null | grep -F "$1 (" >/dev/null
}

ensure_packages() {
  step "Installing prerequisites (curl, ca-certificates, unzip, xz-utils, libatomic1)"
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  [ -r /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
  # Node 26 links against libatomic; Ubuntu 24.04 cloud images ship without it.
  has_shared_library libatomic.so.1 || missing+=(libatomic1)
  if [ ${#missing[@]} -eq 0 ]; then
    info "already present"
    return
  fi
  info "apt-get install ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
}

resolve_version() {
  step "Resolving the vaultgate version"
  if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSL --proto '=https' --tlsv1.2 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${REPO}/releases/latest" |
      sed -n 's/^ *"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$VERSION" ] || die "could not determine the latest release; pass --version X.Y.Z"
  fi
  # Strict: an os-release style "24.04.5 LTS" must never reach the download URL.
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
    die "version must look like X.Y.Z or X.Y.Z-rc.N (got ${VERSION})"
  info "vaultgate ${VERSION}"
}

fetch_release() {
  local base asset
  base="https://github.com/${REPO}/releases/download/v${VERSION}"
  asset="vaultgate-${VERSION}.tgz"
  step "Downloading ${base}/${asset}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${asset}" "${base}/${asset}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${asset}.sha256" "${base}/${asset}.sha256"
  info "verifying against ${asset}.sha256"
  (cd "$WORK" && sha256sum --check --strict "${asset}.sha256")
  mkdir "${WORK}/release"
  tar -xzf "${WORK}/${asset}" -C "${WORK}/release"
  RELEASE_DIR="${WORK}/release/vaultgate-${VERSION}"
  [ -f "${RELEASE_DIR}/dist/main.js" ] || die "unexpected tarball layout: ${RELEASE_DIR}/dist/main.js missing"
}

create_service_user() {
  step "Creating system user ${SERVICE_USER} and ${DATA_DIR}"
  if getent passwd "$SERVICE_USER" >/dev/null; then
    info "user exists"
  else
    useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
      --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
}

install_release() {
  step "Installing to ${INSTALL_ROOT}/${VERSION} (current -> ${VERSION})"
  install -d -m 0755 "$INSTALL_ROOT"
  rm -rf "${INSTALL_ROOT:?}/${VERSION}"
  cp -a "$RELEASE_DIR" "${INSTALL_ROOT}/${VERSION}"
  chown -R root:root "${INSTALL_ROOT}/${VERSION}"
  ln -sfn "${INSTALL_ROOT}/${VERSION}" "${INSTALL_ROOT}/current"
}

# /etc/vaultgate is root-owned but traversable by the service group, so the
# service user can read its own secret files under secrets/ (DEP-4). The
# environment file itself stays root-only: systemd reads it before dropping
# privileges. A re-run corrects the modes of an earlier install.
write_environment_file() {
  step "Configuration ${CONFIG_DIR}/vaultgate.env and ${CONFIG_DIR}/secrets/"
  install -d "$CONFIG_DIR" "${CONFIG_DIR}/secrets"
  chown "root:${SERVICE_USER}" "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${CONFIG_DIR}/secrets"
  chmod 0700 "${CONFIG_DIR}/secrets"
  if [ -e "${CONFIG_DIR}/vaultgate.env" ]; then
    info "exists; left untouched"
    return
  fi
  local secret
  secret=$(head -c 32 /dev/urandom | base64 -w 0)
  sed "s|@SECRET_KEY@|${secret}|" "${RELEASE_DIR}/deploy/systemd/vaultgate.env.example" \
    >"${WORK}/vaultgate.env"
  install -m 0600 -o root -g root "${WORK}/vaultgate.env" "${CONFIG_DIR}/vaultgate.env"
  info "written (mode 0600) with a generated VAULTGATE_SECRET_KEY"
}

# True while the two settings the service cannot start without still hold their
# placeholders. The Bitwarden connection is not checked: it is made from the
# account page after the first sign-in (or seeded through VAULTGATE_BW_*).
has_placeholders() {
  grep -Eq '^VAULTGATE_(PUBLIC_URL|SECRET_KEY)=.*(replace-with|@SECRET_KEY@)' "$1"
}

install_service() {
  step "Installing the systemd unit"
  install -m 0644 -o root -g root "${RELEASE_DIR}/deploy/systemd/vaultgate.service" \
    /etc/systemd/system/vaultgate.service
  systemctl daemon-reload
  if has_placeholders "${CONFIG_DIR}/vaultgate.env"; then
    systemctl enable vaultgate
    STARTED=0
    info "enabled but not started: placeholders remain in ${CONFIG_DIR}/vaultgate.env"
  else
    systemctl enable vaultgate
    # restart rather than enable --now so an upgrade picks up the new release too.
    systemctl restart vaultgate
    STARTED=1
    info "enabled and started"
  fi
}

print_next_steps() {
  step "Done: vaultgate ${VERSION} is installed"
  if [ "$STARTED" -eq 0 ]; then
    cat <<END
    1. Edit ${CONFIG_DIR}/vaultgate.env: set VAULTGATE_PUBLIC_URL to the https
        origin your reverse proxy will serve.
    2. Put a TLS-terminating reverse proxy in front of 127.0.0.1:8080
        (docs/guides/reverse-proxy.md; snippets in ${INSTALL_ROOT}/current/deploy/proxy/).
    3. systemctl start vaultgate
    4. journalctl -u vaultgate -n 50
        The first-run bootstrap URL is in that log; open it to create the operator account.
    5. On the account page, under "Vault connection", enter the Bitwarden personal
        API key and master password. They are stored encrypted; no restart is needed.
        (To seed them from the file instead, set the three VAULTGATE_BW_* values,
        or the matching <NAME>_FILE paths under ${CONFIG_DIR}/secrets/, before step 3.)
END
  else
    cat <<END
    The service is running. If this is a first install, the bootstrap URL is in:
      journalctl -u vaultgate -n 50
    Connect the vault on the console's Vault page once signed in.
    Reverse proxy snippets: ${INSTALL_ROOT}/current/deploy/proxy/ (docs/guides/reverse-proxy.md).
END
  fi
}

main() {
  parse_arguments "$@"
  require_root
  require_debian_family
  ensure_packages
  resolve_version
  WORK=$(mktemp -d)
  chmod 0700 "$WORK"
  trap 'rm -rf "$WORK"' EXIT
  fetch_release
  # shellcheck source=deploy/lib/runtime.sh
  . "${RELEASE_DIR}/deploy/lib/runtime.sh"
  ensure_node
  ensure_bw
  create_service_user
  install_release
  write_environment_file
  install_service
  print_next_steps
}

# Run when executed or piped into bash (BASH_SOURCE is empty on a pipe), not when sourced.
if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
