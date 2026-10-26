# ADR 0009: A read-only credential relay for tagged tailnet nodes

Date: 2026-10-14, amended 2026-10-26 (below). Status: accepted. Specification: [15 The credential relay](../spec/15-credential-relay.md).

## Context

vaultgate's actions (ADR 0007) use a credential without anyone receiving it, and `get_secret`
reveals one field to an agent under audit. Neither serves a program that needs a value in its
own process: a database wrapper that sets `PGPASSWORD`, a script that signs in to an API, a test
harness that logs in to a staging site. Today those programs run on machines with a full vault
client signed in, which puts a master password, or an API key that unlocks the whole vault, on
every such machine.

Agent and build sandboxes are a new kind of such machine. They are short-lived, they can join the
operator's tailnet as tagged, ephemeral nodes, and they run the same programs. Giving each one a
full vault login would repeat the standing-credential problem everywhere. Pasting values into the
environment would expose them to everyone who can configure it, with no audit at all.

## Decision

vaultgate gains a **credential relay**: an opt-in, read-only, `bw serve`-compatible HTTP listener
for tagged tailnet nodes.

- **Compatible, not new.** It answers the read subset of `bw serve` (`/status`, `/list/object/items`,
  `/object/item`, `/object/{username,password,notes,totp,uri}`, and `/sync` as a no-op), so a
  client that already talks to a local `bw serve` switches by changing one URL.
- **Identity from the tailnet.** There is no relay token. The local Tailscale daemon names the
  node behind each connection (`whois`), and only a node carrying a tag the operator listed is
  served, from its own address. A subnet router or exit node is never served, whatever its tags:
  what it forwards would arrive with its identity. Tailscale already holds a key per node and
  expires ephemeral ones; a second credential for the relay would only be another secret for each
  sandbox to hold.
- **Scope by collection or id.** Only items the operator placed in a listed collection, or listed
  by id, exist as far as the relay is concerned; everything else is answered as missing.
- **Secrets through `getSecret`.** The relay composes its answers from `VaultClient` and reads
  every secret through `getSecret`, the one secret path, so it adds no new way into the vault
  backend. It never returns a TOTP seed.
- **Off by default, its own listener.** It runs only with `VAULTGATE_RELAY_LISTEN`, bound to one
  address, never a wildcard, and shares no route with the OAuth, MCP or console listener.

## Consequences

- This is the first vaultgate surface that hands a secret value to a process the operator does
  not run on the vaultgate host. Whatever runs on a tagged node can read every in-scope secret.
  The controls are the tag, the scope and the audit trail. The threat model (T51 to T58) states
  what they do not cover.
- Tailscale becomes a dependency of this feature (not of vaultgate): the daemon must run on the
  vaultgate host, and its LocalAPI socket must be reachable from the service.
- Tagging is the authorisation. A tag granted to the wrong node, or an ACL that lets a tag be
  claimed too widely, widens the relay's audience without any change to vaultgate.
- The actions layer stays the right answer wherever an operation can be expressed as an action:
  then nothing leaves vaultgate at all. The relay is for programs that cannot be reshaped that way.
- ADR 0004 is unchanged: the relay executes nothing and fetches nothing on a caller's behalf.

## Amendment, 2026-10-26: `/sync` syncs

`/sync` was a no-op, so a change made outside vaultgate stayed invisible to every relay caller,
and to vaultgate's own tools, until the next scheduled sync, up to `VAULTGATE_BW_SYNC_INTERVAL`
later. It now asks for the operator's own sync (VAULT-19, the console's **Sync now**), and relay
callers together start at most one every 10 seconds; a request inside that window shares the sync
already started (RELAY-13). A sync reads from the vault server and changes nothing in the vault,
so the relay stays read-only.
