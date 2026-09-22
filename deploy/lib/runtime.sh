#!/usr/bin/env bash
# Runtime installers sourced by install.sh after the release tarball has been
# verified and unpacked. Expects: step, info, die, WORK (scratch directory),
# ARCH (amd64 or arm64), NODE_MAJOR, BW_VERSION, BW_SHA256_AMD64, BW_SHA256_ARM64.
#
# Node comes from nodejs.org with SHASUMS256 verification; the Bitwarden CLI
# comes from its GitHub release with a SHA-256 pinned in install.sh (DEP-5).

node_is_suitable() {
  local major
  [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge "$NODE_MAJOR" ]
}

ensure_node() {
  step "Node.js ${NODE_MAJOR}"
  local candidate
  for candidate in /usr/local/bin/node /usr/bin/node; do
    if node_is_suitable "$candidate"; then
      info "using existing ${candidate} ($("$candidate" --version))"
      [ "$candidate" = /usr/local/bin/node ] || ln -sfn "$candidate" /usr/local/bin/node
      return
    fi
  done
  install_node
}

install_node() {
  local node_arch dist archive name
  case "$ARCH" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    *) die "unsupported architecture ${ARCH}" ;;
  esac
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/SHASUMS256.txt" "${dist}/SHASUMS256.txt"
  archive=$(sed -n "s/^[0-9a-f]\{64\}  \(node-v[0-9.]*-linux-${node_arch}\.tar\.xz\)$/\1/p" \
    "${WORK}/SHASUMS256.txt")
  [ -n "$archive" ] || die "no linux-${node_arch} tarball listed in ${dist}/SHASUMS256.txt"
  info "downloading ${dist}/${archive}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${archive}" "${dist}/${archive}"
  (cd "$WORK" && grep " ${archive}\$" SHASUMS256.txt | sha256sum --check --strict)
  name="${archive%.tar.xz}"
  install -d -m 0755 /usr/local/lib/nodejs
  rm -rf "/usr/local/lib/nodejs/${name}"
  tar -xJf "${WORK}/${archive}" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/${name}/bin/node" /usr/local/bin/node
  info "installed $(/usr/local/bin/node --version) to /usr/local/lib/nodejs/${name}"
}

ensure_bw() {
  step "Bitwarden CLI ${BW_VERSION}"
  if [ -x /usr/local/bin/bw ] && [ "$(/usr/local/bin/bw --version 2>/dev/null)" = "$BW_VERSION" ]; then
    info "already installed at /usr/local/bin/bw"
    return
  fi
  local suffix sha asset url
  case "$ARCH" in
    amd64)
      suffix=""
      sha="$BW_SHA256_AMD64"
      ;;
    arm64)
      suffix="-arm64"
      sha="$BW_SHA256_ARM64"
      ;;
    *) die "unsupported architecture ${ARCH}" ;;
  esac
  asset="bw-linux${suffix}-${BW_VERSION}.zip"
  url="https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/${asset}"
  info "downloading ${url}"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${WORK}/${asset}" "$url"
  echo "${sha}  ${WORK}/${asset}" | sha256sum --check --strict
  unzip -qo "${WORK}/${asset}" bw -d "${WORK}/bw"
  install -m 0755 -o root -g root "${WORK}/bw/bw" /usr/local/bin/bw
  info "installed Bitwarden CLI $(/usr/local/bin/bw --version)"
}
