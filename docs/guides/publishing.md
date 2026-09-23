# Publishing to the MCP Registry

How the maintainer publishes vaultgate's listing to the official
[MCP Registry](https://registry.modelcontextprotocol.io) with the `mcp-publisher` CLI. Nothing in
CI publishes; every step below is run by hand, from a machine signed in to GitHub as the
repository owner. Verified against the registry documentation on 2026-09-23
([modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry), `docs/`); the
registry describes itself as "currently in preview", so re-read the
[publishing guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
before each release.

## The listing: `server.json`

[`server.json`](../../server.json) at the repository root is the listing. What each field does and
why it has the value it has:

| Field         | Value                                     | Why                                                                                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`     | `…/schemas/2025-12-11/server.schema.json` | The schema version the registry's own examples use.                                                                                                                                                                                                                                                                              |
| `name`        | `io.github.adamrowles1996/vaultgate`      | GitHub authentication grants the `io.github.<username>/*` namespace and nothing else; the name **must** start with it. Reverse-DNS form, exactly one `/`.                                                                                                                                                                        |
| `description` | one sentence                              | Capped at 100 characters by the schema. That is why it does not spell out the per-instance URL; the `host` variable does.                                                                                                                                                                                                        |
| `repository`  | URL, `source: github`, numeric `id`       | The `id` is `gh api repos/adamrowles1996/vaultgate --jq .id`; the registry uses it to notice a deleted-and-recreated repository.                                                                                                                                                                                                 |
| `version`     | the same string as `package.json`         | The registry requires a version string that is unique per publication and cannot be changed afterwards; semantic prereleases such as `0.1.0-rc.3` are recommended. Keep the two files equal (see below).                                                                                                                         |
| `remotes`     | `streamable-http` at `https://{host}/mcp` | vaultgate is self-hosted: every operator has a different origin, and there is no shared endpoint to list. The registry's documented answer for that is a URL template with `variables`; a client that supports the registry asks the user for `host` and resolves the URL. Templates must still be `https://` and not localhost. |

Not in the listing yet: a `packages` entry for the container image. The registry verifies
ownership of an OCI package through a `LABEL io.modelcontextprotocol.server.name="io.github.adamrowles1996/vaultgate"`
on the image, which is a Dockerfile change and a released image. Add it in its own PR when wanted;
the `remotes` entry stays as it is because vaultgate is not a stdio server.

## Check the file locally

Before every publish, from the repository root:

```bash
python3 -m json.tool server.json > /dev/null   # well-formed JSON
npx prettier --check server.json               # formatted the way the repository formats JSON
mcp-publisher validate                         # schema and registry rules, reported all at once
```

`mcp-publisher validate` reads `./server.json` by default, sends it to the registry's validation
endpoint and publishes nothing. It needs no login. It is the same check `publish` runs first.

## Install `mcp-publisher`

Pre-built binaries are attached to the registry's releases; Homebrew also has it.

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

```bash
brew install mcp-publisher
```

`mcp-publisher --help` lists `init`, `login`, `logout`, `publish`, `status` and `validate`. Do not
run `init` here: it would overwrite `server.json` with a `TODO:` template.

## Log in

```bash
mcp-publisher login github
```

This starts GitHub's device flow: open `https://github.com/login/device`, enter the code the CLI
prints, authorise. The token grants the personal namespace `io.github.adamrowles1996/*`, which is
all this listing needs; it asks for no repository scopes. (An organisation namespace would need the
Owner role in that organisation. A CI publish would use `mcp-publisher login github-oidc` from a
GitHub Actions job; vaultgate does not do that.)

The credential is stored locally by the CLI; `mcp-publisher logout` clears it.

## Publish

From the repository root, on the tagged release commit:

```bash
mcp-publisher publish
```

It validates, then creates the version. Confirm it is listed:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.adamrowles1996%2Fvaultgate/versions/latest"
```

`GET /v0.1/servers/{serverName}/versions` lists every published version.

## Every release

`version` in `server.json` must equal `version` in `package.json`, and each publish needs a new
version string, so publishing is a step of the release, after the tag:

1. The release PR bumps `package.json`, `package-lock.json` and `server.json` together.
2. After the tag and the image are out, run `mcp-publisher validate` then `mcp-publisher publish`
   on that commit.
3. A version cannot be edited once published. A mistake is fixed by publishing the next version and
   marking the wrong one deprecated:

```bash
mcp-publisher status --status deprecated --message "superseded by 0.1.0-rc.4" io.github.adamrowles1996/vaultgate 0.1.0-rc.3
```

`--status deleted` hides a version; `--all-versions` applies the change to every version of the
server (with `--yes` to skip the prompt).

## What the listing does not do

- It does not host anything. The registry stores metadata; the server is still yours to run.
- It does not make any instance reachable. A user of the listing supplies their own `host`.
- It is not a security review. The registry's checks are namespace ownership, schema validity and
  the remote-URL rules above.
