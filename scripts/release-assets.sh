#!/usr/bin/env bash
# Builds the GitHub release assets for one version, after `npm run build`:
#   release/vaultgate-<version>.tgz         dist, production node_modules, package.json,
#                                           package-lock.json, deploy/, install.sh
#   release/vaultgate-<version>.tgz.sha256  sha256sum line, as install.sh verifies it
#   release/notes.md                        the matching CHANGELOG.md section
# Usage: scripts/release-assets.sh <version>
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

asset="vaultgate-${version}.tgz"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "release/${asset}" -C "$stage" "vaultgate-${version}"
(cd release && sha256sum "$asset" >"${asset}.sha256")

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
