# vaultgate container image (docs/spec/09-deployment.md, DEP-2).
#
# Debian slim rather than Alpine: the Bitwarden CLI is a single-file binary
# linked against glibc. Every input is pinned: the base image by digest, the
# CLI by version and SHA-256 per architecture, npm packages by the lockfile.
#
# Stages: bw-amd64 and bw-arm64 fetch the CLI for one architecture, `bw`
# verifies and unpacks the one matching the build platform, `build` compiles
# TypeScript and prunes to production dependencies, `runtime` is what ships.

# The four FROM lines below share one base reference so Dependabot (docker
# ecosystem) can bump the digest; keep them identical.
ARG TARGETARCH

# Bitwarden CLI release tag cli-v<version> (https://github.com/bitwarden/clients/releases).
# The release publishes no checksum file, so the digests were computed from the
# downloaded assets when the version was pinned. Keep equal to install.sh;
# src/bitwarden/versions.test.ts checks that and the minimum (COMPAT-1).
ARG BW_VERSION=2026.9.0
ARG BW_SHA256_AMD64=580c1deec8345b19dbac7f8b02babb6cc4fe250c69c567e29061f727f1e40768
ARG BW_SHA256_ARM64=3f474cc34b701a1cebdd486009870038b034343afb83095607422cdad4c3653a

FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS bw-amd64
ARG BW_VERSION
ARG BW_SHA256_AMD64
ENV BW_SHA256=${BW_SHA256_AMD64}
ADD https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-${BW_VERSION}.zip /tmp/bw.zip

FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS bw-arm64
ARG BW_VERSION
ARG BW_SHA256_ARM64
ENV BW_SHA256=${BW_SHA256_ARM64}
ADD https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-arm64-${BW_VERSION}.zip /tmp/bw.zip

# The stage alias is built from the target platform; hadolint cannot see that
# bw-amd64 and bw-arm64 above are already pinned by digest.
# hadolint ignore=DL3006
FROM bw-${TARGETARCH} AS bw
ARG BW_VERSION
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# unzip exists only in this build stage. Debian keeps a single version of each
# package in the bookworm archive, so a version pin here would break the build
# at the next point release; the base image digest pins the archive snapshot.
# hadolint ignore=DL3008
RUN echo "${BW_SHA256}  /tmp/bw.zip" | sha256sum --check --strict \
  && apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/* \
  && unzip -q /tmp/bw.zip bw -d /opt/bw \
  && chmod 0755 /opt/bw/bw \
  && [ "$(/opt/bw/bw --version)" = "${BW_VERSION}" ]

FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts: the lockfile pins every package; no install script is needed
# to compile vaultgate, and none gets to run inside the image build.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS runtime
ARG BW_VERSION
LABEL org.opencontainers.image.title="vaultgate" \
  org.opencontainers.image.description="Remote MCP server for Bitwarden with OAuth 2.1" \
  org.opencontainers.image.source="https://github.com/adamrowles1996/vaultgate" \
  org.opencontainers.image.licenses="Apache-2.0" \
  com.vaultgate.bitwarden-cli.version="${BW_VERSION}"
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 vaultgate \
  && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home \
    --shell /usr/sbin/nologin vaultgate \
  && mkdir -p /data \
  && chown vaultgate:vaultgate /data \
  && chmod 0700 /data
WORKDIR /app
COPY --from=bw /opt/bw/bw /usr/local/bin/bw
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER 10001:10001
VOLUME /data
ENV VAULTGATE_HOST=0.0.0.0 \
  VAULTGATE_DATA_DIR=/data \
  VAULTGATE_BW_BIN=/usr/local/bin/bw \
  NODE_ENV=production
EXPOSE 8080
# No curl in the image: the probe is Node's own fetch against the liveness route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.VAULTGATE_PORT ?? 8080}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
