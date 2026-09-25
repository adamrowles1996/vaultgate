#!/usr/bin/env bash
# Checks install.sh without installing anything: the file is sourced (its main
# guard keeps it from running) and the argument, operating-system and package
# logic is driven against a fake os-release with stubbed host commands.
# Regression for the sourced /etc/os-release that clobbered VERSION.
# Usage: scripts/test-install-sh.sh   (npm run test:install-sh)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}
expect_equal() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$3', got '$2'"; fi
}
expect_contains() {
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1: '$3' not found in '$2'" ;;
  esac
}

cat >"$work/ubuntu" <<'END'
PRETTY_NAME="Ubuntu 24.04.5 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.5 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
END
cat >"$work/fedora" <<'END'
PRETTY_NAME='Fedora Linux 42'
ID=fedora
VERSION='42 (Workstation)'
END

bash -n "$root/install.sh" && pass "install.sh parses"

export OS_RELEASE_FILE="$work/ubuntu"
# shellcheck source=/dev/null
. "$root/install.sh"
pass "sourcing install.sh does not run main"

# Stubs for the host commands the checked functions reach.
systemctl() { :; }
dpkg() { echo amd64; }
apt-get() { printf 'apt-get %s\n' "$*"; }
ldconfig() { :; }
curl() { printf '{\n  "tag_name": "v9.9.9",\n  "name": "v9.9.9"\n}\n'; }
export -f systemctl dpkg apt-get ldconfig curl

parse_arguments --version 1.2.3
expect_equal "--version sets VERSION" "$VERSION" "1.2.3"
os_check=$(require_debian_family)
expect_equal "reading os-release leaves VERSION alone" "$VERSION" "1.2.3"
expect_contains "os-release PRETTY_NAME is reported" "$os_check" "Ubuntu 24.04.5 LTS is supported"
expect_contains "architecture is reported" "$os_check" "architecture amd64"
expect_equal "single-quoted os-release values are unquoted" \
  "$(OS_RELEASE_FILE="$work/fedora" os_release_field PRETTY_NAME)" "Fedora Linux 42"
if (OS_RELEASE_FILE="$work/fedora" require_debian_family >/dev/null 2>&1); then
  fail "a non-Debian os-release is refused"
else
  pass "a non-Debian os-release is refused"
fi

expect_contains "resolve_version keeps an explicit version" "$(resolve_version)" "vaultgate 1.2.3"
if (VERSION="24.04.5 LTS (Noble Numbat)" resolve_version >/dev/null 2>&1); then
  fail "an os-release VERSION is rejected as a vaultgate version"
else
  pass "an os-release VERSION is rejected as a vaultgate version"
fi
expect_contains "resolve_version asks GitHub when no version is given" \
  "$(VERSION="" resolve_version)" "vaultgate 9.9.9"
expect_contains "a release candidate is a valid version" \
  "$(VERSION="0.1.0-rc.1" resolve_version)" "vaultgate 0.1.0-rc.1"
expect_contains "--help prints the usage" "$(parse_arguments --help)" "usage: install.sh"
if (parse_arguments --bogus >/dev/null 2>&1); then
  fail "an unknown argument is refused"
else
  pass "an unknown argument is refused"
fi

printf 'VAULTGATE_PUBLIC_URL=https://replace-with-your-domain\nVAULTGATE_SECRET_KEY=abc\n' >"$work/env-url"
printf 'VAULTGATE_PUBLIC_URL=https://vault.example\nVAULTGATE_SECRET_KEY=@SECRET_KEY@\n' >"$work/env-key"
printf 'VAULTGATE_PUBLIC_URL=https://vault.example\nVAULTGATE_SECRET_KEY=abc\n#VAULTGATE_BW_PASSWORD=\n' >"$work/env-ready"
printf 'VAULTGATE_PUBLIC_URL=https://vault.example\nVAULTGATE_SECRET_KEY=abc\nVAULTGATE_BW_PASSWORD=replace-with-x\n' >"$work/env-bw"
if has_placeholders "$work/env-url"; then pass "a placeholder public URL holds the start"; else fail "a placeholder public URL holds the start"; fi
if has_placeholders "$work/env-key"; then pass "an unrendered secret key holds the start"; else fail "an unrendered secret key holds the start"; fi
if has_placeholders "$work/env-ready"; then fail "a complete file starts the service"; else pass "a complete file starts the service"; fi
if has_placeholders "$work/env-bw"; then fail "Bitwarden placeholders do not hold the start"; else pass "Bitwarden placeholders do not hold the start"; fi

expect_contains "libatomic1 is installed when the library is absent" \
  "$(ensure_packages)" "apt-get install -y -q --no-install-recommends"
expect_contains "libatomic1 is in the apt list" "$(ensure_packages)" "libatomic1"

# The code sidecar (ACT-114): the flag, the upgrade-with-the-core rule and the
# environment settings it appends without touching anything else.
WITH_CODE_SIDECAR=0
parse_arguments --with-code-sidecar --version 1.2.3
expect_equal "--with-code-sidecar sets WITH_CODE_SIDECAR" "$WITH_CODE_SIDECAR" "1"
if wants_code_sidecar; then pass "the flag asks for the sidecar"; else fail "the flag asks for the sidecar"; fi
WITH_CODE_SIDECAR=0
if [ -e /etc/systemd/system/vaultgate-code.service ]; then
  pass "an installed sidecar is upgraded with the core (skipped: this host has one)"
elif wants_code_sidecar; then
  fail "without the flag or an installed sidecar, none is installed"
else
  pass "without the flag or an installed sidecar, none is installed"
fi
# shellcheck source=deploy/lib/code-sidecar.sh
. "$root/deploy/lib/code-sidecar.sh"
CONFIG_DIR="$work/etc"
mkdir -p "$CONFIG_DIR"
printf 'VAULTGATE_ENABLE_ACTIONS=true\n#VAULTGATE_ACTIONS_ENABLE_CODE=false\nVAULTGATE_HOST=127.0.0.1\n' \
  >"$CONFIG_DIR/vaultgate.env"
connect_code_sidecar >/dev/null
connect_code_sidecar >/dev/null
env_file=$(<"$CONFIG_DIR/vaultgate.env")
expect_contains "the code switch is appended" "$env_file" $'\nVAULTGATE_ACTIONS_ENABLE_CODE=true\n'
expect_contains "the socket URL is appended" "$env_file" "VAULTGATE_ACTIONS_CODE_URL=unix:/run/vaultgate-code/code.sock"
expect_contains "the commented-out default stays" "$env_file" "#VAULTGATE_ACTIONS_ENABLE_CODE=false"
expect_equal "a second run appends nothing" \
  "$(grep -c '^VAULTGATE_ACTIONS_' "$CONFIG_DIR/vaultgate.env")" "2"
printf 'VAULTGATE_ACTIONS_CODE_URL=http://code:8000\n' >"$CONFIG_DIR/vaultgate.env"
expect_contains "an operator's URL is kept" "$(connect_code_sidecar)" "VAULTGATE_ACTIONS_CODE_URL already set"
expect_contains "a missing master switch is pointed out" "$(connect_code_sidecar)" "VAULTGATE_ENABLE_ACTIONS=true as well"
expect_equal "an operator's URL is not replaced" \
  "$(grep -c '^VAULTGATE_ACTIONS_CODE_URL=http://code:8000$' "$CONFIG_DIR/vaultgate.env")" "1"
if (CODE_PYTHON=python9.99 ensure_code_python >/dev/null 2>&1); then
  fail "a system without Python 3.12 is refused"
else
  pass "a system without Python 3.12 is refused"
fi
expect_contains "the refusal points at the image" \
  "$( (CODE_PYTHON=python9.99 ensure_code_python) 2>&1 || true)" "install-docker-compose.md"

if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'install.sh checks passed\n'
