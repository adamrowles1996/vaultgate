#!/usr/bin/env bash
# Packages deploy/chatgpt-plugin as a ChatGPT plugin ZIP for one vaultgate deployment: the
# template's placeholder server URL becomes <public-url>/mcp and its version becomes the
# package.json version. plugin.json sits at the root of the archive, as ChatGPT expects.
# Usage: scripts/chatgpt-plugin.sh <public-url> [output.zip]
#   <public-url>  the deployment's VAULTGATE_PUBLIC_URL, e.g. https://vaultgate.example.com
#   output.zip    defaults to vaultgate-chatgpt-plugin.zip in the current directory
set -euo pipefail

usage() {
  echo "usage: scripts/chatgpt-plugin.sh <public-url> [output.zip]" >&2
  exit 2
}
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage

public_url="${1%/}"
# An origin only: the character set also keeps the sed replacement and the JSON string safe.
if ! [[ "$public_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "<public-url> must be an https:// origin with no path, as in VAULTGATE_PUBLIC_URL" >&2
  exit 2
fi
command -v zip >/dev/null || {
  echo "zip is not installed" >&2
  exit 1
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
template="${root}/deploy/chatgpt-plugin"
placeholder="https://vaultgate.example.com/mcp"
version=$(sed -n -E 's/^  "version": "([^"]+)",$/\1/p' "${root}/package.json")
[ -n "$version" ] || {
  echo "no version found in package.json" >&2
  exit 1
}
output="${2:-vaultgate-chatgpt-plugin.zip}"
case "$output" in
  /*) ;;
  *) output="${PWD}/${output}" ;;
esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R "${template}/." "$stage"
sed -i.orig "s|\"url\": \"${placeholder}\"|\"url\": \"${public_url}/mcp\"|" "${stage}/mcp.json"
sed -i.orig -E "s|^  \"version\": \"[^\"]+\",$|  \"version\": \"${version}\",|" "${stage}/plugin.json"
rm -f "${stage}"/*.orig
grep -q "\"url\": \"${public_url}/mcp\"" "${stage}/mcp.json" || {
  echo "the server URL placeholder was not found in ${template}/mcp.json" >&2
  exit 1
}
grep -q "\"version\": \"${version}\"" "${stage}/plugin.json" || {
  echo "the version line was not found in ${template}/plugin.json" >&2
  exit 1
}

rm -f "$output"
(cd "$stage" && zip -q -X -r "$output" plugin.json mcp.json skills assets)
echo "wrote ${output}: vaultgate ${version} for ${public_url}/mcp"
