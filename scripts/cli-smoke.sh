#!/usr/bin/env bash
# Runs the audit export CLI against a fresh data directory. No store exists
# yet, so JSON Lines prints nothing and CSV prints only its header row, both
# with exit 0; a bad window is refused with a usage error.
# Usage: scripts/cli-smoke.sh node dist/cli.js
set -euo pipefail

data_dir="$(mktemp -d)"
trap 'rm -rf "$data_dir"' EXIT
export VAULTGATE_DATA_DIR="$data_dir"
# Only the two required settings; no vault or server is contacted.
export VAULTGATE_PUBLIC_URL=http://127.0.0.1:18080
VAULTGATE_SECRET_KEY="$(head -c 32 /dev/urandom | base64)"
export VAULTGATE_SECRET_KEY

from=2026-01-01T00:00:00Z
to=2026-12-31T00:00:00Z
header='id,at,category,action,outcome,operatorId,clientId,tokenPrefix,itemId,field,requestId,ip,durationMs,details'

jsonl="$("$@" audit export --from "$from" --to "$to")"
if [ -n "$jsonl" ]; then
  echo "expected no JSON Lines output from an empty store, got: ${jsonl}" >&2
  exit 1
fi

csv="$("$@" audit export --from "$from" --to "$to" --format csv | tr -d '\r')"
if [ "$csv" != "$header" ]; then
  echo "expected only the CSV header from an empty store, got: ${csv}" >&2
  exit 1
fi

if "$@" audit export --from "$to" --to "$from" 2>/dev/null; then
  echo "expected a usage error for a window that ends before it starts" >&2
  exit 1
fi

echo "cli smoke: empty JSON Lines and CSV header exports succeeded"
