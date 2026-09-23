#!/usr/bin/env bash
# Boots the server with the given command, waits for /healthz, then stops it.
# Usage: scripts/smoke-test.sh node dist/main.js
set -euo pipefail

port="${VAULTGATE_PORT:-18080}"
export VAULTGATE_HOST=127.0.0.1 VAULTGATE_PORT="$port"
# Only the two required settings; the vault backend starts unconfigured (no credentials).
VAULTGATE_PUBLIC_URL="http://127.0.0.1:${port}"
VAULTGATE_SECRET_KEY="$(head -c 32 /dev/urandom | base64)"
export VAULTGATE_PUBLIC_URL VAULTGATE_SECRET_KEY

"$@" &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl --silent --fail "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    body=$(curl --silent "http://127.0.0.1:${port}/healthz")
    echo "healthz: ${body}"
    kill "$pid"
    wait "$pid" || true
    exit 0
  fi
  sleep 0.2
done

echo "server did not become healthy on port ${port}" >&2
exit 1
