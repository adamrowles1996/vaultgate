#!/usr/bin/env bash
# The login-session cap (DEP-13), sourced by install.sh from the release being installed.
# A release without this file has no cap: install.sh then refuses --cap-login-sessions and leaves
# an installed drop-in as it is.

SESSION_CAP_FILE="${SESSION_CAP_FILE:-/etc/systemd/system/user-.slice.d/50-vaultgate-headroom.conf}"

# Asked for with --cap-login-sessions; once installed, every re-run keeps it current.
wants_session_cap() {
  [ "${CAP_LOGIN_SESSIONS:-0}" -eq 1 ] || [ -e "$SESSION_CAP_FILE" ]
}

# Installs the release's user-.slice drop-in. systemd applies it to running user slices on the
# daemon-reload in install_service, so no session or service restarts.
install_session_cap() {
  step "Capping login sessions (${SESSION_CAP_FILE})"
  install -d -m 0755 -o root -g root "$(dirname "$SESSION_CAP_FILE")"
  install -m 0644 -o root -g root \
    "${RELEASE_DIR}/deploy/systemd/user-.slice.d/50-vaultgate-headroom.conf" "$SESSION_CAP_FILE"
  info "each login user's sessions now share the capped budget that file sets"
}

cap_login_sessions() {
  if wants_session_cap; then
    install_session_cap
  fi
}
