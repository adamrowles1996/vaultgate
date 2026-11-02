---
name: use-vaultgate
description: >-
  Work with systems whose credentials live in the user's Bitwarden vault through vaultgate,
  without the secret values entering the conversation. Use when the user asks to call an API,
  query or change a database, run a command on a server, search or read code in a repository,
  or look up what the vault holds, and vaultgate's tools are available.
---

# Use vaultgate

vaultgate is the user's own gateway to their vault. It runs an operation with a vault
credential on the user's behalf and returns the result with every injected value replaced by
`[redacted:<field>]`, so a credential never has to be read to be used. The user's explicit
instructions take priority over this guidance.

## Pick the route

1. **To act on a system, start with `actions_list_targets`.** Each target has a `name`, the
   operator's `description` of what it is for, its `connector`, the `operations` it allows
   (`read`, `write`, `shell`) and, for SQL targets, its `engine`. Choose the target whose
   description matches the task. If none does, say so and stop; never guess a host, URL or
   database, because no tool accepts one.
2. **Call the connector tool with that name as `target`:**
   - `http_request`: `method` and a `path` under the target's base URL, with optional `headers`
     and `body`. vaultgate adds authentication itself, so never set `Authorization`.
   - `sql_query` for reads and `sql_execute` for changes: exactly one statement per call, in the
     target's dialect. Put every value in `params` and reference it as `$1…$n` on `postgres` or
     `@p1…@pn` on `mssql`. Never build values into the SQL text.
   - `ssh_run` or `winrm_run`: one command, which must match the operator's allowlist for that
     target. Nothing persists between calls.
   - `code_search` (with `repo` and `query`), then go straight to the file and line it returns
     with `code_read`. Use `code_find_related` to find similar code. Do not repeat a search for
     the same thing.
3. **To see what the vault holds**, use `search_items` and then `get_item` on an id. These
   return metadata only, with flags such as `has_password` in place of values.
4. **`get_secret` is the last resort.** Use it only when the user asks to see a value or the
   task cannot be done through any target. It returns one field of one item, and every call is
   audited. Never repeat a secret in a reply, a file, code or a command unless the user
   explicitly asks for it.

## Changes

`sql_execute`, `ssh_run`, `winrm_run`, any `http_request` other than `GET`, `HEAD` or
`OPTIONS`, and the vault write tools can change things. Before calling one, say which target it
affects and what will change, and go ahead only when the user has asked for that change or
approved it. Each SQL call is its own transaction, so order multi-step changes so that a failure
part-way leaves things safe.

## When a call fails

- A tool is missing or fails with `insufficient_scope`: the ChatGPT connection lacks that
  scope. Tell the user to reconnect vaultgate in ChatGPT and tick the scope on vaultgate's
  consent page.
- `actions_list_targets` is empty, or a call fails with `not_granted`: the operator must grant
  the target to ChatGPT on the Agents page of the vaultgate console.
- `policy_denied`: the target's policy refuses the operation; `detail.reason` says why. Report
  it. Do not work around it with `get_secret` or another target.
- `credential_unavailable` or `vault_unavailable`: call `vault_status` and report its `state`.
- `rate_limited`: wait `detail.retry_after_s` seconds before trying again.
- `index_not_ready` from code search: the repository is still being indexed; retry shortly.

A non-2xx HTTP status or a non-zero exit code is a normal result, not a vaultgate error: report
it as it is.
