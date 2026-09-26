# Code search: Semble connections

A **Semble connection** lets an agent search a GitHub repository as it would search a local
checkout with [`semble`](https://github.com/MinishLab/semble)'s own MCP server: `code_search`
for a focused query, `code_find_related` from a location it found, and `code_read` for a file.
vaultgate fetches the repository from GitHub with a read-only token from the vault, a sidecar
builds `semble` indexes over each commit, and the token never reaches the agent, the sidecar or
a log. The connector's id is `code` and its scope `actions:code`; the specification is
[14a The `code` connector](../spec/14a-code-connector.md) and the decision
[ADR 0008](../adr/0008-code-search-connector.md).

This guide assumes the actions layer is set up as in [Actions](actions.md): targets (shown in the
console as _connections_), grants and consent.

## 1. Run the sidecar

The index is never built in vaultgate's own process. Install the sidecar with your install
method, which also sets `VAULTGATE_ACTIONS_ENABLE_CODE=true` and `VAULTGATE_ACTIONS_CODE_URL`:

| Install         | How                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Debian / Ubuntu | `install.sh --with-code-sidecar` ([Install on Debian or Ubuntu](install-linux.md#5-the-code-search-sidecar-optional)) |
| Docker Compose  | the `code` profile ([Install with Docker Compose](install-docker-compose.md#4-the-code-search-sidecar-optional))      |
| Azure           | `deployCodeSidecar=true` ([the Azure template](../../deploy/azure/README.md))                                         |

Keep `VAULTGATE_ENABLE_ACTIONS=true`. At start-up vaultgate asks the sidecar for its protocol
version, `semble` version and model and logs them (`code sidecar ready`); a sidecar of another
protocol version turns the three tools off with a start-up error rather than failing each call.

## 2. A token in the vault

Create a **fine-grained personal access token** on GitHub (Settings → Developer settings →
Personal access tokens → Fine-grained tokens):

- **Resource owner**: the user or organisation whose repositories it will read. One token covers
  one owner, so an organisation and your own account need one each.
- **Repository access**: all repositories, or the ones you will connect.
- **Permissions**: **Contents: Read-only** and **Metadata: Read-only**, nothing else. Pull
  request heads (`ref: "pr:<n>"`) are read through `refs/pull/<n>/head`, which Contents covers.

Save it in a vault item, as the item's password or as a hidden custom field. One token can
serve a connection for every repository its owner has. A public repository needs no token.

A classic token with the `repo` scope also works, but it can write to every repository you can;
vaultgate only ever reads with it, and a fine-grained read-only token keeps that true even if
the item is used elsewhere.

## 3. Add a Semble connection

One connection is one repository. In the console, **Connections → Add connection → Semble ·
GitHub code search**, pick the vault item that holds the token, then fill in the form:

| Field                | What it is                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                 | How agents name the repository: `claude-setup`, `application-main`. Lower-case letters, digits and hyphens.                                                |
| Description          | Shown to agents in `actions_list_targets`: say what is in the repository.                                                                                  |
| Token field          | The item field that holds the token: `password` by default, any other field (hidden custom fields included), or **No token**.                              |
| Repository           | `owner/name`. The list beside it holds every repository the token can read; or type one.                                                                   |
| Ref                  | Empty for the repository's default branch, or a branch, tag or full commit SHA.                                                                            |
| Content types        | `code`, `docs` and `config`; all three by default. A repository of Markdown needs `docs`.                                                                  |
| Include / Exclude    | gitignore patterns, one per line. The exclude list starts with secrets-shaped files (`.env`, `*.pem`, `id_rsa*`…); replacing it replaces them.             |
| Allow `code_read`    | Whether agents may read whole files (on by default).                                                                                                       |
| Allow a per-call ref | Whether agents may search another branch, tag, commit or `pr:<n>` (on by default).                                                                         |
| Limits               | `max_top_k`, how long a call waits for a first build (`build_wait_s`), how often the ref is checked (`refresh_interval_s`), and the archive and read caps. |

**Check without saving** asks GitHub for the repository with that token and shows whether it can
read it, its default branch and its visibility, never the token. **Create** saves the connection
and starts the first build in the background.

A repository that holds credentials in files the exclude list does not name is still a
repository of credentials: the agent can read what the index holds. Extend the list, or leave
the repository out. The content types limit what is searched, not what `code_read` reads: it
reads any file the patterns keep. With a per-call ref allowed, an agent may also name a commit
SHA, and GitHub serves every commit of a repository's fork network through each repository in
it; turn the per-call ref off for a repository whose forks hold what the grant should not cover.

## 4. Grant it

Agents use a connection only when you grant it to their client on the **Agents** page, under
**Who can use what**, and when their token carries `actions:code` (ticked on the consent page).
A grant to one connection gives nothing on the others.

## 5. What agents can do

```text
code_search        query, repo, [ref], [content], [top_k=5], [max_snippet_lines=10], [paths], [languages]
code_find_related  file_path, line, repo, [ref], [content], [top_k=5], [max_snippet_lines=10]
code_read          repo, file_path, [ref], [start_line], [end_line]
```

- `repo` is a connection name, or for the two search tools a list of up to ten, searched
  together. With several, every `file_path` begins with the connection name and a `/`, as
  `semble` prefixes merged repositories, and `code_find_related` takes such a path.
- `content` is `code`, `docs`, `config` or `all`; the default is every type the connection
  allows.
- `max_snippet_lines`: `0` for the location only, `N` for the first `N` lines of each chunk,
  `null` for the whole chunk.
- `ref`, with one `repo` only: a branch, a tag, a 40-character SHA or `pr:<n>`.

Each result names its connection, `file_path`, `start_line`, `end_line`, `score` and `language`;
`repos` says which commit answered, when it was indexed and whether it is `stale` (the ref has
moved and the new commit is still building). The tool descriptions and vaultgate's handshake
instructions carry `semble`'s own advice: search once with a focused query, go straight to the
returned file and line, follow up with `code_find_related`, and ask for
`max_snippet_lines: null` when a snippet is not enough.

The first call on a commit that has no index waits for the build, up to `build_wait_s` (90 s by
default), as `semble` indexes a repository on its first call; a larger repository answers
`index_not_ready` with `state: building`, and a later call finds it. The errors an agent can
meet are listed in [Tools and scopes](tools-and-scopes.md#actions-error-codes).

## 6. Parity with `semble`'s MCP server

`code_search` and `code_find_related` take `semble` 0.6.1's `search` and `find_related`
arguments with the same defaults, rank with the same library and model
(`minishlab/potion-code-16M-v2`), cut snippets by the same rule and prefix merged repositories
the same way. The differences:

- **No local paths and no other forges.** `semble`'s `repo` can be a directory or any git URL;
  here it is a connection name, and a connection is a GitHub repository the operator chose. An
  agent never chooses what the server reads or fetches (ADR 0004).
- **Merged results carry the connection name**, not the repository directory's name.
- **`content` defaults to what the connection allows**, not to the server's configuration.

vaultgate adds `ref`, `code_read`, the `paths` and `languages` filters, and each repository's
`commit` and `stale`.

## 7. Operating it

- **The Index card** on a connection's page shows each snapshot (commit, the ref it came from,
  when it was built, and whether calls answer from it), its indexes with their file and chunk
  counts, what was skipped, the last check of the ref, and the last failure's reason code.
  **Rebuild index** deletes every snapshot of the connection and builds the configured ref again.
- **Builds happen** when a connection is created or its repository, token field, content,
  patterns or caps change (every old snapshot is deleted first), when you press Rebuild index,
  and when a call needs a commit that is not indexed yet. The configured ref is checked again
  when its last check is older than `refresh_interval_s`; nothing rebuilds on a timer.
- **Deleting a connection** deletes its snapshots. An unreachable sidecar does not block that;
  vaultgate deletes what is left over when it next reaches the sidecar.
- **Storage and memory** belong to the sidecar: by default 64 snapshots and 8 GiB on disk, and
  1 GiB of loaded indexes in memory, least recently used out first
  ([the sidecar's README](../../sidecars/code/README.md)). A sidecar that loses its storage loses
  only the time to rebuild.
- **Audit**: every call is recorded per repository with its query, path and lines, and every
  build as `actions.code_index_built` or `actions.code_index_failed` with its commit, trigger,
  counts and duration. No file content is ever recorded.
- **Where the code lives**: each snapshot is a plaintext copy of the repository in the
  sidecar's storage, never in vaultgate's data directory or its backups.
