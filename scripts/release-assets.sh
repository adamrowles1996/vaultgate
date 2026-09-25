#!/usr/bin/env bash
# Builds the GitHub release assets for one version, after `npm run build`:
#   release/vaultgate-<version>.tgz              dist, production node_modules, package.json,
#                                                package-lock.json, deploy/, install.sh
#   release/vaultgate-<version>.tgz.sha256       sha256sum line, as install.sh verifies it
#   release/vaultgate-code-<version>.tgz         the code sidecar for the systemd install
#                                                (ACT-113): app/vaultgate_code, the hash-locked
#                                                requirements.txt exported from uv.lock, the
#                                                lock itself, README, PROTOCOL, LICENSE, NOTICE
#   release/vaultgate-code-<version>.tgz.sha256
#   release/notes.md                             the matching CHANGELOG.md section
# Usage: scripts/release-assets.sh <version>   (needs uv on PATH for the sidecar bundle)
set -euo pipefail

version="${1:?usage: scripts/release-assets.sh <version>}"
manifest_version=$(node -p "require('./package.json').version")
if [ "$version" != "$manifest_version" ]; then
  echo "tag version ${version} does not match package.json version ${manifest_version}" >&2
  exit 1
fi
[ -f dist/main.js ] || {
  echo "dist/main.js missing: run npm run build first" >&2
  exit 1
}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="${stage}/vaultgate-${version}"
mkdir -p "$root" release

cp -R dist deploy install.sh package.json package-lock.json .npmrc "$root"/
(cd "$root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -f .npmrc)

# One reproducible tarball of a staged directory, and its checksum line.
pack() {
  local name="$1"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -czf "release/${name}.tgz" -C "$stage" "$name"
  (cd release && sha256sum "${name}.tgz" >"${name}.tgz.sha256")
}

pack "vaultgate-${version}"

sidecar="sidecars/code"
code_root="${stage}/vaultgate-code-${version}"
mkdir -p "${code_root}/app"
cp -R "${sidecar}/src/vaultgate_code" "${code_root}/app/"
find "${code_root}/app" -name '__pycache__' -prune -exec rm -rf {} +
cp "${sidecar}/README.md" "${sidecar}/PROTOCOL.md" "${sidecar}/pyproject.toml" \
  "${sidecar}/uv.lock" LICENSE NOTICE "$code_root"/
uv export --project "$sidecar" --frozen --no-dev --no-emit-project --format requirements-txt \
  --output-file "${code_root}/requirements.txt" >/dev/null
grep -q -- '--hash=sha256:' "${code_root}/requirements.txt" || {
  echo "the exported sidecar requirements carry no hashes" >&2
  exit 1
}
pack "vaultgate-code-${version}"

# Release notes: the CHANGELOG section for this version, up to the next heading.
awk -v heading="## [${version}]" '
  index($0, heading) == 1 { printing = 1; next }
  printing && /^## / { exit }
  printing { print }
' CHANGELOG.md >release/notes.md
if ! grep -q '[^[:space:]]' release/notes.md; then
  echo "CHANGELOG.md has no section '## [${version}]'" >&2
  exit 1
fi

ls -l release
