# ADR 0008: A `code` connector: search and read repositories through a sidecar

Date: 2026-09-24. Status: accepted (planned for M16). Amends
[ADR 0004](0004-no-remote-command-execution.md) and
[ADR 0007](0007-typed-actions-with-operator-policy.md).

## Context

The operator's agents work on code they cannot see. A hosted agent (Claude on the web, Claude
Cowork, Codex in the cloud) has no checkout of the operator's private repositories, and the ways
it could get one all put a credential where vaultgate exists to keep it out: a personal access
token pasted into the conversation, or a `vault:reveal` of the token followed by the agent's own
`git clone`. The token then sits in the model's context and the transcript, and it usually grants
far more than the one repository the task needed.

Local agents solve the retrieval half with a code-search engine beside the checkout. `semble`
(MinishLab, MIT) is a good one: it chunks source with tree-sitter, embeds the chunks with a small
static `model2vec` model on the CPU, combines that with BM25, and needs no API key and no network
once its model is present. Its own MCP server is the wrong shape for vaultgate, however. It
accepts any local directory path or any `https://` or `http://` git URL as an argument and clones
it itself, so exposing it behind a bearer token would let an agent choose what the host reads and
fetches: exactly what ADR 0004 refuses. It is also 0.6.0, pre-1.0, with a small maintainer team.

ADR 0007's framework already answers the credential half. The operator defines a target, the
agent names it, and vaultgate uses a credential the agent never receives. What is new here is
state: every connector so far performs one operation per call and keeps nothing, while search
needs a snapshot of the repository and an index built from it, kept between calls.

## Decision

vaultgate gains a seventh connector, `code` ([spec 14.8](../spec/14-actions-connectors.md)), off
unless its own switch is on, with one scope, `actions:code`, and three read-only tools:
`code_search`, `code_find_related` and `code_read`.

- **Targets, not tools, as before.** A `code` target names a GitHub repository and a ref that the
  operator typed, and a vault field holding a read-only token. An agent passes a query, a path or
  a line; it never passes a repository, a URL, a host or a directory, so it can influence what is
  searched within the snapshot and never what is fetched.
- **vaultgate fetches, the sidecar parses.** vaultgate resolves the ref to a commit and downloads
  that commit's archive from the GitHub API with the injected token, through the pinned transport
  of ACT-55 to ACT-57, and streams the compressed bytes to the sidecar without decompressing or
  storing them. The token never leaves vaultgate. The sidecar extracts the archive under strict
  rules (no links, no devices, no path escape, size and count caps), builds the index and answers
  queries. It never holds a credential and, in the Compose deployment, has no route to the
  internet at all.
- **The engine runs in its own container, behind our protocol.** The sidecar is an image this
  repository builds: Python, `semble` pinned by hash, and the embedding model downloaded at build
  time and verified by checksum, so nothing is fetched at run time. vaultgate speaks a narrow JSON
  protocol to it (build, search, related, read, delete, health). `semble` is used as a library
  (`SembleIndex.from_path`, `search`, `find_related`, `save`, `load_from_disk`), never through
  its MCP server or its `from_git`, so the engine can be replaced inside the sidecar without
  touching vaultgate, its tools or its specification.
- **No timers.** An index is built when the operator saves the target or presses Rebuild, and is
  refreshed when a call finds its freshness check older than the policy's interval and the ref
  has moved. The call that triggers a refresh is answered from the current snapshot and says so.
  A target nobody calls costs nothing.
- **Isolation from `bw serve` is a placement rule.** In Compose the sidecar is its own container
  on an internal network, so it cannot reach vaultgate's loopback. On Azure it is a separate
  Container App with internal-only ingress, never a second container of vaultgate's app: the
  containers of one app share a network namespace, and `bw serve` listens on that loopback with no
  authentication of its own (ADR 0003, ACT-56).

## Amendments

- **ADR 0004** refused any tool that reads a file. `code_read` reads a file, but only from the
  snapshot of a repository the operator chose, resolved inside that snapshot, and never from the
  vaultgate host or any host the agent names. The vault tools are unchanged, and so is the rule
  that nothing executes on the vaultgate host: the sidecar is a separate container, and
  `child_process` stays lint-confined.
- **ADR 0007** fixed six connectors and spec 13.17 declined further ones "until each has a policy
  model as tight as these". `code` is read-only by construction (no tool writes, so there is
  nothing to confirm), its destination is fixed by the operator, and its outputs pass the same
  scrubber and caps as every other connector's. The 13.17 non-goal "no file access tool" gains
  the one exception above.

## Consequences

- **A new kind of data at rest.** A repository snapshot and its index are a plaintext copy of the
  repository, held in the sidecar's storage. vaultgate itself still stores no content: nothing
  reaches its data directory or its backups. The threat model records the snapshot as an asset,
  the guide says the sidecar's volume is as sensitive as the repository, and deleting a target
  deletes its index.
- **Returned code is untrusted text.** Retrieved files can carry instructions aimed at the agent,
  as any destination data can (T25). Results are data, the scope is marked risky, and the
  repository is the operator's choice.
- **Secrets committed to a repository are served like any other file.** The scrubber covers the
  values vaultgate injected, not whatever a repository contains, so the policy ships default
  exclusions for the common secret-file names and the operator can widen them.
- **A second sidecar image** joins the release: built, scanned and signed like the core image,
  with its own Python dependency audit. The core image stays Python-free.
- **A migration.** `action_targets.connector` carries a `CHECK` over the connector names, and
  SQLite cannot alter a `CHECK`, so migration `005` rebuilds the table to admit `code`.
- **GitHub first.** The forge is `github` (github.com) in M16. GitHub Enterprise Server, GitLab
  and Gitea or Forgejo are post-M16 candidates; each needs its own archive and redirect rules.
- **The same placement question applies to the `browser` sidecar.** ACT-92 places Chromium as a
  second container of vaultgate's Container App on Azure, on the shared loopback where `bw serve`
  listens. That placement should be revisited with M15, separately from this record. (Done on
  2026-09-24: ACT-92 now places the browser in a separate internal-ingress Container App too.)
- Milestone M16 in `PLAN.md` delivers it, behind `VAULTGATE_ACTIONS_ENABLE_CODE`, with contract
  tests against a fake forge and a fake sidecar, a hostile-archive suite in the sidecar's own
  tests, and a live test against one of the maintainer's private repositories.
