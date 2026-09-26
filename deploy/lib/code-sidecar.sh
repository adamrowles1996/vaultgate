#!/usr/bin/env bash
# The code connector's sidecar for the systemd install (docs/spec/14a-code-connector.md,
# ACT-113 and ACT-114), sourced by install.sh after the release tarball has been verified
# and unpacked, when --with-code-sidecar is given or the sidecar is already installed.
# Expects: step, info, die, WORK, VERSION, REPO, RELEASE_DIR, CONFIG_DIR, SERVICE_USER.
#
# It runs in two halves around the core's own install. stage_code_sidecar does everything
# that can fail (Python, the bundle, the virtual environment, the model) into a staging
# directory before anything installed changes; activate_code_sidecar then moves it into place
# and restarts the sidecar, and a sidecar that does not come up is reported without stopping
# the core's upgrade.
#
# The bundle vaultgate-code-<version>.tgz is published beside the core tarball and verified
# against its .sha256 the same way. Its Python dependencies are installed from the release's
# hash-locked requirements (pip --require-hashes, wheels only) into a virtual environment,
# and the embedding model is downloaded at its pinned revision and checked file by file
# against the SHA-256 digests in the bundle's model.json. The sidecar itself never touches
# the network: its unit has none.

CODE_ROOT="/opt/vaultgate-code"
CODE_USER="vaultgate-code"
CODE_STATE_DIR="/var/lib/vaultgate-code"
CODE_SOCKET="/run/vaultgate-code/code.sock"
CODE_UNIT="/etc/systemd/system/vaultgate-code.service"
CODE_PYTHON="${CODE_PYTHON:-python3.12}"

# True when the Python the sidecar is locked for can create a virtual environment.
code_python_ready() {
  command -v "$CODE_PYTHON" >/dev/null 2>&1 &&
    "$CODE_PYTHON" -c 'import ensurepip, venv' >/dev/null 2>&1
}

ensure_code_python() {
  step "Python 3.12 for the code sidecar"
  if code_python_ready; then
    info "using $(command -v "$CODE_PYTHON") ($("$CODE_PYTHON" --version 2>&1))"
    return
  fi
  if ! command -v "$CODE_PYTHON" >/dev/null 2>&1; then
    die "the code sidecar needs Python 3.12 (${CODE_PYTHON}), which this system does not" \
      "package; use Ubuntu 24.04, or run the sidecar image (docs/guides/install-docker-compose.md)"
  fi
  info "apt-get install python3.12-venv"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends python3.12-venv
  code_python_ready || die "${CODE_PYTHON} still cannot create a virtual environment"
}

fetch_code_bundle() {
  local base asset
  base="https://github.com/${REPO}/releases/download/v${VERSION}"
  asset="vaultgate-code-${VERSION}.tgz"
  step "Downloading ${base}/${asset}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${asset}" "${base}/${asset}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${asset}.sha256" "${base}/${asset}.sha256"
  info "verifying against ${asset}.sha256"
  (cd "$WORK" && sha256sum --check --strict "${asset}.sha256")
  mkdir "${WORK}/code"
  tar -xzf "${WORK}/${asset}" -C "${WORK}/code"
  CODE_BUNDLE_DIR="${WORK}/code/vaultgate-code-${VERSION}"
  [ -f "${CODE_BUNDLE_DIR}/app/vaultgate_code/__main__.py" ] ||
    die "unexpected bundle layout: app/vaultgate_code/__main__.py missing"
  [ -f "${CODE_BUNDLE_DIR}/requirements.txt" ] ||
    die "unexpected bundle layout: requirements.txt missing"
}

create_code_user() {
  step "Creating system user ${CODE_USER}"
  if getent passwd "$CODE_USER" >/dev/null; then
    info "user exists"
  else
    # A group left behind by an earlier userdel is reused rather than refused.
    local group=(--user-group)
    getent group "$CODE_USER" >/dev/null && group=(--gid "$CODE_USER")
    useradd --system "${group[@]}" --home-dir "$CODE_STATE_DIR" --no-create-home \
      --shell /usr/sbin/nologin "$CODE_USER"
  fi
  # vaultgate opens the sidecar's socket through this group, and nobody else can.
  if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx "$CODE_USER"; then
    info "${SERVICE_USER} is already in group ${CODE_USER}"
  else
    usermod -a -G "$CODE_USER" "$SERVICE_USER"
    info "added ${SERVICE_USER} to group ${CODE_USER}"
  fi
}

# The application, a virtual environment built from the locked requirements, and the
# verified model, built in a staging directory beside the installed releases; every file is
# root's and read-only to the service.
build_code_tree() {
  CODE_STAGING="${CODE_ROOT}/.staging-${VERSION}"
  step "Building the code sidecar ${VERSION} in ${CODE_STAGING}"
  install -d -m 0755 "$CODE_ROOT"
  rm -rf "${CODE_STAGING:?}"
  install -d -m 0755 "$CODE_STAGING"
  cp -R "${CODE_BUNDLE_DIR}/app" "${CODE_BUNDLE_DIR}/requirements.txt" "$CODE_STAGING"/
  info "creating the virtual environment"
  "$CODE_PYTHON" -m venv "${CODE_STAGING}/venv"
  info "pip install --require-hashes --only-binary=:all: -r requirements.txt"
  PIP_DISABLE_PIP_VERSION_CHECK=1 "${CODE_STAGING}/venv/bin/pip" install --quiet --no-cache-dir \
    --require-hashes --no-deps --only-binary=:all: -r "${CODE_STAGING}/requirements.txt"
  info "downloading the embedding model at its pinned revision and checking its digests"
  PYTHONPATH="${CODE_STAGING}/app" "${CODE_STAGING}/venv/bin/python" -m vaultgate_code.fetch_model \
    --dest "${CODE_STAGING}/model"
  "${CODE_STAGING}/venv/bin/python" -m compileall -q "${CODE_STAGING}/app"
  chown -R root:root "$CODE_STAGING"
  chmod -R u=rwX,go=rX "$CODE_STAGING"
}

# Moves the staged tree to /opt/vaultgate-code/<version> and points current at it. A re-run of
# the installed version keeps the running tree until the staged one is complete.
place_code_tree() {
  local target="${CODE_ROOT}/${VERSION}"
  step "Installing the code sidecar to ${target} (current -> ${VERSION})"
  rm -rf "${target:?}.previous"
  [ ! -e "$target" ] || mv "$target" "${target}.previous"
  mv "$CODE_STAGING" "$target"
  ln -sfn "$target" "${CODE_ROOT}/current"
  rm -rf "${target:?}.previous"
}

write_code_environment_file() {
  local file="${CONFIG_DIR}/vaultgate-code.env"
  if [ -e "$file" ]; then
    info "${file} exists; left untouched"
    return
  fi
  cat >"${WORK}/vaultgate-code.env" <<'END'
# Limits of the code sidecar (sidecars/code/README.md); the defaults are shown.
# Its snapshots and indexes live in /var/lib/vaultgate-code and can always be rebuilt.
#VAULTGATE_CODE_MAX_SNAPSHOTS=64
#VAULTGATE_CODE_MAX_STORAGE_BYTES=8589934592
#VAULTGATE_CODE_MAX_MEMORY_BYTES=1073741824
#VAULTGATE_CODE_BUILD_CONCURRENCY=1
END
  install -m 0644 -o root -g root "${WORK}/vaultgate-code.env" "$file"
  info "wrote ${file} (defaults, commented out)"
}

# Appends NAME=VALUE to an environment file when NAME is not set there yet (commented-out
# lines do not count), leaving every other line as it was.
ensure_environment_setting() {
  local file="$1" name="$2" value="$3"
  if grep -Eq "^${name}=" "$file"; then
    info "${name} already set in ${file}; left as it is"
    return
  fi
  printf '%s=%s\n' "$name" "$value" >>"$file"
  info "set ${name}=${value} in ${file}"
}

connect_code_sidecar() {
  local file="${CONFIG_DIR}/vaultgate.env"
  [ -e "$file" ] || return 0
  if ! grep -q '^# The code connector' "$file"; then
    printf '\n# The code connector and its sidecar (install.sh --with-code-sidecar).\n' >>"$file"
  fi
  ensure_environment_setting "$file" VAULTGATE_ACTIONS_ENABLE_CODE true
  ensure_environment_setting "$file" VAULTGATE_ACTIONS_CODE_URL "unix:${CODE_SOCKET}"
  grep -Eq '^VAULTGATE_ENABLE_ACTIONS=true' "$file" ||
    info "note: the connector needs VAULTGATE_ENABLE_ACTIONS=true as well (${file})"
}

# Waits for the sidecar's socket: it verifies the model's digests before it listens. A sidecar
# that does not come up is reported, not fatal: the core's upgrade goes on, and the code tools
# answer index_unavailable until the sidecar answers.
wait_for_code_socket() {
  local waited=0
  while [ ! -S "$CODE_SOCKET" ]; do
    if [ "$waited" -ge "${CODE_SOCKET_WAIT:-90}" ]; then
      info "WARNING: the sidecar did not open ${CODE_SOCKET} within ${CODE_SOCKET_WAIT:-90} s;" \
        "see journalctl -u vaultgate-code -n 50"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  info "listening on ${CODE_SOCKET}"
}

install_code_service() {
  step "Installing the code sidecar's systemd unit"
  install -m 0644 -o root -g root "${RELEASE_DIR}/deploy/systemd/vaultgate-code.service" "$CODE_UNIT"
  write_code_environment_file
  systemctl daemon-reload
  systemctl enable vaultgate-code
  systemctl restart vaultgate-code
  wait_for_code_socket
}

# Everything that can fail, before anything installed changes.
stage_code_sidecar() {
  ensure_code_python
  fetch_code_bundle
  create_code_user
  build_code_tree
}

activate_code_sidecar() {
  place_code_tree
  install_code_service
  connect_code_sidecar
}
