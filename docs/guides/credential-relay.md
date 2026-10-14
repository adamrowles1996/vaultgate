# Credential relay

The credential relay lets programs on **tagged nodes of your Tailscale tailnet** read the secrets
you choose, through the same API a local `bw serve` offers. A script that already reads its
database password from `bw serve` on `127.0.0.1:8087` reads it from the relay by changing one URL,
and the machine it runs on needs no vault login of its own.

Normative detail: [spec 15](../spec/15-credential-relay.md). Why it exists and what it trades
away: [ADR 0009](../adr/0009-tailnet-credential-relay.md).

## Before you enable it

The relay hands secret values out. Prefer an [action](actions.md) wherever the work can be
expressed as one, because then nothing leaves vaultgate at all. Use the relay for programs that
must hold the value themselves, on machines you are content to trust with every secret in its
scope.

Enabling it extends this trust: **every in-scope secret, in plaintext, to any process on any node
that carries one of the tags you list.** Keep the scope to the items those programs need, and keep
the tag to the nodes that run them.

## Requirements

- The [Debian or Ubuntu install](install-linux.md) (systemd). The relay must see each caller's
  tailnet address, so it shares the host's network; in a container behind a published port every
  caller appears as the bridge's address and is refused.
- Tailscale on the vaultgate host, joined to the tailnet. The relay asks the local daemon who
  each caller is over its LocalAPI socket (`/var/run/tailscale/tailscaled.sock` by default), which
  any local user may read.
- An organisation collection for the items in scope, or the items' ids.

## 1. Prepare the tailnet

Give the callers a tag of their own, owned by you alone, and let it reach the vaultgate host on the
relay's port only. In the tailnet policy file:

```json
{
  "tagOwners": { "tag:sandbox": ["autogroup:admin"] },
  "grants": [{ "src": ["tag:sandbox"], "dst": ["tag:vaultgate"], "ip": ["tcp:8087"] }]
}
```

Join the callers with **ephemeral, pre-authorised** keys or an OAuth client that assigns that tag,
so a node disappears when its machine does. Anyone who can create a node with the tag is an
admitted caller, so treat the key like a credential.

The relay never admits a subnet router or an exit node, even one carrying the tag: devices behind
it reach the tailnet under its identity, so admitting it would admit them. Give routers a tag of
their own; a router that carries the callers' tag is refused, and the audit log says `router`.

## 2. Choose the scope

Create a collection in your organisation (for example _Relay_), add only the items the callers
need, and note its id: it is the `collectionId` in the web vault's address bar when the collection
is open. An item can sit in several collections, so adding it to this one changes nothing else.
You can also list individual items by id.

The relay answers logins and secure notes that are not in the trash. Everything else is answered
exactly as an item that does not exist, so a caller cannot learn what lies outside the scope.

## 3. Configure vaultgate

Add to `/etc/vaultgate/vaultgate.env`, using the host's tailnet address (`tailscale ip -4`):

```sh
VAULTGATE_RELAY_LISTEN=100.64.0.10:8087
VAULTGATE_RELAY_TAGS=tag:sandbox
VAULTGATE_RELAY_COLLECTIONS=00000000-0000-0000-0000-000000000000
#VAULTGATE_RELAY_ITEMS=
#VAULTGATE_RELAY_TAILSCALE_SOCKET=/var/run/tailscale/tailscaled.sock
```

Then `sudo systemctl restart vaultgate`. The log shows `credential relay listening`. If the
tailnet interface is not up yet, it shows `credential relay could not listen; retrying` and tries
again every 10 seconds; the rest of vaultgate is unaffected.

## 4. Verify

From a tagged node:

```sh
curl -s http://100.64.0.10:8087/status
# {"success":true,"data":{"object":"template","template":{…,"status":"unlocked"}}}
curl -s http://100.64.0.10:8087/object/username/<item id>
```

From any other node the answer is `403` `Forbidden.`, and so is a request that sends an `Origin`
header or addresses the relay by a name instead of its address. Each request appears in the
audit log in category `relay` (`vaultgate audit export`), with the caller's node name.

## Clients

Any client of `bw serve`'s read API works. Point it at `http://<address>:<port>` and drop any
unlock step: the relay has no `/unlock` and never needs one. Lookups take an item id or a name. A
name that matches several items answers the one whose name it is exactly, and otherwise reports
`More than one result was found.`, as `bw serve` does. TOTP seeds are never returned; the `totp`
route answers the current code.

## Operating it

- **Remove an item from the scope** by taking it out of the collection. The relay sees the
  change at the vault's next sync (`VAULTGATE_BW_SYNC_INTERVAL`, or **Sync now** on the Vault page).
- **Switch the relay off** by removing `VAULTGATE_RELAY_LISTEN` and restarting.
- **Shut out one node** by removing it, or its tag, in the Tailscale admin console; the relay
  refuses it from its next request.
- Each node may make 300 requests a minute; past that the relay answers `429` with `Retry-After`.
