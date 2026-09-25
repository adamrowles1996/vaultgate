# vaultgate code sidecar image (docs/spec/14a-code-connector.md, ACT-113; PROTOCOL.md).
#
# Built from this directory: docker build -t vaultgate-code sidecars/code
#
# Every input is pinned: the base images by digest, the Python packages by the
# SHA-256 of each wheel in uv.lock, and the embedding model by its Hugging Face
# revision and the size and SHA-256 of each file in src/vaultgate_code/model.json.
#
# Stages: `uv` supplies the pinned uv binary, `requirements` exports the lock to
# a hash-pinned requirements file, `deps` installs it into a virtual environment
# (wheels only, no dependency resolution), `model` downloads and verifies the
# model, `runtime` is what ships. The image runs with a read-only root: it
# writes only to its state volume.

# The three python FROM lines share one reference so Dependabot (docker
# ecosystem) can bump the digest; keep them identical.
FROM ghcr.io/astral-sh/uv:0.11.8@sha256:3b7b60a81d3c57ef471703e5c83fd4aaa33abcd403596fb22ab07db85ae91347 AS uv

FROM python:3.14-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS deps
WORKDIR /build
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
# --only-binary: every locked package ships a wheel for amd64 and arm64, so no
# build backend or compiler runs. --no-deps: the export is the whole closure.
RUN uv export --frozen --no-dev --no-emit-project --format requirements-txt -o requirements.txt \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
    --require-hashes --no-deps --only-binary :all: -r requirements.txt

FROM python:3.14-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS model
WORKDIR /build
COPY src ./src
# The standard library alone: fetch_model downloads each pinned file at the
# pinned revision and refuses any byte that does not match.
RUN PYTHONPATH=/build/src python3 -m vaultgate_code.fetch_model --dest /opt/vaultgate-code/model \
  && chmod 0755 /opt/vaultgate-code/model

FROM python:3.14-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS runtime
LABEL org.opencontainers.image.title="vaultgate-code" \
  org.opencontainers.image.description="The code-search sidecar of vaultgate's code connector (semble)" \
  org.opencontainers.image.source="https://github.com/adamrowles1996/vaultgate" \
  org.opencontainers.image.licenses="Apache-2.0"
RUN groupadd --gid 10002 vaultgate-code \
  && useradd --uid 10002 --gid 10002 --home-dir /nonexistent --no-create-home \
    --shell /usr/sbin/nologin vaultgate-code \
  && mkdir -p /var/lib/vaultgate-code \
  && chown 10002:10002 /var/lib/vaultgate-code \
  && chmod 0700 /var/lib/vaultgate-code
COPY --from=deps /opt/venv /opt/venv
COPY --from=model /opt/vaultgate-code/model /opt/vaultgate-code/model
COPY src /opt/vaultgate-code/src
RUN python3 -m compileall -q /opt/vaultgate-code/src
ENV PATH=/opt/venv/bin:$PATH \
  PYTHONPATH=/opt/vaultgate-code/src \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  HF_HUB_OFFLINE=1
USER 10002:10002
WORKDIR /var/lib/vaultgate-code
VOLUME /var/lib/vaultgate-code
EXPOSE 8000
# No curl in the image: the probe is the standard library against /v1/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python3", "-c", "import sys, urllib.request; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/v1/health', timeout=4).status != 200)"]
ENTRYPOINT ["python3", "-m", "vaultgate_code"]
CMD ["serve", "--listen", "0.0.0.0:8000", "--state", "/var/lib/vaultgate-code", "--model", "/opt/vaultgate-code/model"]
