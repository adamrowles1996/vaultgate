# HTTP targets: private certificates and OAuth 2.0 tokens

[Actions](actions.md#creating-an-http-target) covers creating and calling an `http` target. This
guide covers what some APIs need beyond a base URL and a secret:

- [a destination with its own certificate](#a-destination-with-its-own-certificate): an internal
  API whose certificate no public authority signed, with [Proxmox VE](#proxmox-ve) worked through;
- [Microsoft Graph targets](#microsoft-graph-targets): the `graph` credential mode, where
  vaultgate obtains the Graph access token itself;
- [OAuth 2.0 targets](#oauth-20-targets): the `oauth2` credential mode, the same for any OAuth 2.0
  token endpoint, with [Power BI](#power-bi-rest-api), [Microsoft Fabric](#microsoft-fabric-rest-api),
  [Azure Resource Manager](#azure-resource-manager), [national-cloud Graph](#microsoft-graph-in-a-national-cloud),
  [Zoho Books](#zoho-books), [HubSpot](#hubspot) and [Xero](#xero) worked through.

Every host, address and identifier below is an example. The specification is
[§14.2 to §14.3a](../spec/14-actions-connectors.md#142-http).

## A destination with its own certificate

By default an `https://` destination is verified against the system certificate store, which is
right for a public API and wrong for an internal one whose certificate no public authority signed:
every call fails with `tls_error`. The destination can name the trust to use instead, in one of two
optional fields. Both are `https://` only, and you give one or the other, never both; a save that
breaks either rule is refused with every problem listed.

- **Certificate fingerprint (SHA-256)** pins the one certificate the API presents: 64 hexadecimal
  digits, with or without colons, in either case. The pin _replaces_ the store. vaultgate holds the
  connection until the certificate the server presented matches, so nothing — least of all the
  credential — is sent to a host that fails it. No name or address is checked: the pin is the
  whole of the verification.
- **Certificate authority (PEM)** trusts a private authority: paste its certificate (several, one
  after another, if there is more than one), with its line breaks, from
  `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`. The authority also _replaces_ the
  store — the system roots and anything in `NODE_EXTRA_CA_CERTS` are not consulted for this
  target — and the verification is Node's own: the chain must lead to what you pasted, the
  certificate must be in date, and it must carry the base URL's host. A host name is matched
  against the certificate's DNS names; a base URL written with an IP address is matched against
  its IP addresses.

**Which one.** Pin when the API has one certificate that rarely changes and you can read it from
the machine itself; it is the narrowest statement you can make about a host, and it needs no
agreement between the certificate and the name you reach it by. Use the authority when a
certificate is renewed often, or when several hosts share one authority (every node of a Proxmox
VE cluster, say): the authority survives renewals, and one PEM serves every node. The price is the
naming rule: the base URL's host must be a name or an address the certificate carries.

**Renewal.** A pin names one certificate, so a renewed or replaced certificate fails every call
with `tls_error` (`ERR_TLS_CERT_PIN_MISMATCH`) until you edit the target with the new fingerprint.
An authority keeps working for as long as the same authority signs the new certificate.

**Only the destination.** The pin or the authority applies to every request sent to the base
URL's origin — the request the agent asked for and each redirect hop vaultgate follows — and to
nothing else. A token exchange (the `graph` and `oauth2` modes below) is always verified against
the system store: the private trust vouches for your API, not for an identity provider.

**When it fails.** A certificate the trust refuses fails the call with `tls_error`, and `detail`
names only the reason code, never the address:

| `detail.reason`                                                | What it means                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ERR_TLS_CERT_PIN_MISMATCH`                                    | The certificate is not the pinned one: renewed, replaced, or not the host you meant. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | The authority you pasted did not sign this certificate.                              |
| `ERR_TLS_CERT_ALTNAME_INVALID`                                 | The certificate does not carry the base URL's host (the naming rule above).          |
| `CERT_HAS_EXPIRED`                                             | The certificate is out of date.                                                      |

Saving a target resolves its host but never connects, so a trust problem shows on the first call,
not at save. The target's page says which trust is in use: its **Network** line reads, for
example, `internal · encrypted · private certificate authority` or `… · pinned certificate`.

## Proxmox VE

The Proxmox VE API listens on port 8006 of every node, under `/api2/json`. Out of the box each
node's certificate (`/etc/pve/local/pve-ssl.pem`) is signed by the cluster's own authority, the
"PVE Cluster Manager CA", whose certificate every node holds at `/etc/pve/pve-root-ca.pem`. The
system store knows neither, so a plain `http` target fails with `tls_error`; either kind of
private trust fixes it. (A node you have moved to an ACME certificate, such as Let's Encrypt,
needs neither: leave both fields empty and the system store verifies it. Keep that in mind if you
switch later — an authority field naming the cluster's root would then refuse the new
certificate.)

### The API token

Give vaultgate a user and an API token of its own, with only the rights the agent needs. On any
node, as root:

```bash
pveum user add vaultgate@pve --comment 'vaultgate actions'
pveum acl modify / --users vaultgate@pve --roles PVEAuditor
pveum user token add vaultgate@pve agent --privsep 0
```

`PVEAuditor` is read-only; `PVEVMUser` adds VM power management, on `/vms` or on one VM's path if
you want to narrow it. `--privsep 0` lets the token carry exactly the user's rights; with
privilege separation on (the web UI's default), grant the same role to the token as well
(`pveum acl modify / --tokens 'vaultgate@pve!agent' --roles PVEAuditor`), because a separated
token gets the intersection of the two. The command prints the token's secret, a UUID, once:
store it in the vault item, in the password field or a hidden custom field such as
`custom.pve-token`.

### Choosing the trust

**The cluster's authority** (recommended for a cluster): on any node,

```bash
cat /etc/pve/pve-root-ca.pem
```

and paste the whole PEM into **Certificate authority (PEM)**. It serves every node of the cluster
and survives the renewal of their certificates.

The naming rule matters here. A node's certificate names the node, not necessarily the address
you reach it at. Look at what it carries:

```bash
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -ext subjectAltName
```

It usually lists the node's short name, its name under the node's search domain, `localhost`,
`127.0.0.1` and the address the node's own name resolved to when the certificate was made. The
base URL's host must be one of those. If vaultgate reaches the node by an address the certificate
does not list (a second interface, a NAT address), use a name the certificate does carry and make
it resolve to that address **on the vaultgate host** — in DNS, or in the container's `/etc/hosts`
(`extra_hosts:` in `docker-compose.yml`); vaultgate resolves the name through the system resolver
once per call. Or pin the certificate instead, which checks no name at all.

**Or the node's certificate** (one node, or when the naming rule gets in the way): read the
fingerprint the listener presents,

```bash
openssl s_client -connect pve.example.internal:8006 -servername pve.example.internal </dev/null 2>/dev/null |
  openssl x509 -noout -fingerprint -sha256
```

and check it on the node itself, so you are not pinning whatever answered on the network:
`pvenode cert info` lists each certificate with its fingerprint, and for the default certificate
`openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256` prints the same digits
(a custom certificate is `/etc/pve/local/pveproxy-ssl.pem`). Paste the 64 hexadecimal digits into
**Certificate fingerprint (SHA-256)**, colons or not. Every node has its own certificate, so every
node needs its own target and its own pin, and each pin must be updated when that node's
certificate is renewed — after `pvecm updatecerts --force`, or when you upload a new one.

### The target

| Field                          | Value                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Name                           | `pve`                                                                                |
| Description                    | `The Proxmox VE cluster API: read VM and node status.`                               |
| Internal destination           | ticked (the node is on a private address)                                            |
| Base URL                       | `https://pve.example.internal:8006/api2/json`                                        |
| Certificate authority (PEM)    | the PEM of `/etc/pve/pve-root-ca.pem` (or a fingerprint instead)                     |
| Injection mode                 | `header`                                                                             |
| Secret field                   | `password` (or `custom.pve-token`)                                                   |
| Header or query parameter name | `Authorization`                                                                      |
| Value prefix                   | `PVEAPIToken=vaultgate@pve!agent=` (user, realm and token id, then `=`)              |
| Allowed methods                | `GET` (add `POST` only for actions such as starting a VM)                            |
| Allowed paths                  | `/version`, `/cluster/resources*`, `/nodes/*/qemu`, `/nodes/*/qemu/*/status/current` |

The header mode sends `Authorization: PVEAPIToken=vaultgate@pve!agent=<secret>`, which is exactly
the form the Proxmox VE API expects; the prefix is not secret, and the secret itself is scrubbed
from anything the API echoes back. An agent can never set or replace the `Authorization` header
itself. A token needs no `CSRFPreventionToken`, which only the ticket sign-in uses, so a `POST`
such as `/nodes/*/qemu/*/status/start` works once you allow the method and the path — and is a
call that changes something, with everything that implies.

The same target as documents:

```json
{
  "destination": {
    "base_url": "https://pve.example.internal:8006/api2/json",
    "ca_pem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"
  },
  "credential": {
    "mode": "header",
    "field": "password",
    "name": "authorization",
    "prefix": "PVEAPIToken=vaultgate@pve!agent="
  },
  "policy": {
    "allowed_methods": ["GET"],
    "allowed_paths": [
      "/version",
      "/cluster/resources*",
      "/nodes/*/qemu",
      "/nodes/*/qemu/*/status/current"
    ]
  }
}
```

`/cluster/resources*` also allows the query an agent adds (`/cluster/resources?type=vm`): a `*`
stops only at a `/`. An agent then calls, for example,
`http_request { "target": "pve", "method": "GET", "path": "/cluster/resources?type=vm" }`.

## Microsoft Graph targets

The `graph` credential mode makes vaultgate obtain the Microsoft Graph access token itself, so
the agent never sees the client secret, the refresh token or the access token — it only ever
calls `http_request` on a target whose `base_url` is `https://graph.microsoft.com` (a path
prefix such as `/v1.0` is allowed, and then every `path` the agent gives is relative to it). It is
the preset of the [`oauth2` mode](#oauth-20-targets) for the global Graph service, with the token
URL, the header and the default scope filled in.

**In Entra ID.** Register an application, note its **Directory (tenant) ID** and **Application
(client) ID**, and create a client secret. Then choose the grant:

- **Client credentials** — the application acts as itself. Give it _application_ permissions
  (for example `User.Read.All`) and grant admin consent. The scope stays
  `https://graph.microsoft.com/.default`, which means "every application permission this app has
  consented to"; Microsoft rejects any other scope for this grant.
- **Refresh token** — the application acts as one signed-in user. Give it the _delegated_
  permissions you need, add `offline_access`, and obtain a refresh token once through an
  interactive sign-in of that user (the authorization-code flow, outside vaultgate). The scope is
  then the delegated scopes you want on each token, space separated, for example
  `https://graph.microsoft.com/User.Read offline_access`.

**In the vault.** Put the client secret in a field of one item — a hidden custom field is the
natural home — and, for the refresh-token grant, put the refresh token in a second hidden custom
field of the same item. Map them as **Client secret field** (`custom.<name>`) and **Refresh token
field**, with the tenant in **Graph tenant id** and the application in **Application (client)
id**.

**What happens on a call.** Before the request, vaultgate posts the grant to
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` through the same pinned transport
the request uses: the host is resolved and checked against the private-range rule like any other
destination. The access token is held in process memory only, keyed by the target and its
revision, until sixty seconds before it expires; it is never stored and never logged, and it is
redacted from every result as `[redacted:graph.access_token]`. Editing the target retires the
cached token. A `401` from Graph discards it and the request is retried once with a fresh one; a
second `401` is returned as the result, like any other status.

**Rotation.** Microsoft rotates refresh tokens: when the token endpoint returns a new one,
vaultgate writes it back into the mapped vault field **before** it makes the Graph request and
records an `actions.credential_rotated` event naming the target, the item and the field (never
the value). If that write-back fails the call fails with `credential_rotation_failed` rather
than proceeding, so you learn while the old token still works — check that the vault is unlocked
and that the mapped field is one vaultgate can write (a custom field, the login password or the
notes).

**Errors.** `authentication_failed` means the token endpoint rejected the credential
(`invalid_client`: the secret is wrong or expired; `invalid_grant`: the refresh token is spent,
revoked or for another tenant); the OAuth error code is in `detail.error` and the call history
carries it too. Any other answer from the token endpoint is `upstream_error` with its status.

## OAuth 2.0 targets

The `oauth2` credential mode does for any OAuth 2.0 API what the `graph` mode does for Microsoft
Graph: vaultgate obtains the access token itself, from the token endpoint you name, and puts it
in the request. The agent calls `http_request` as on any other target and never sees the client
secret, the refresh token or the access token.

Use it for an API whose tokens come from a token endpoint by one of two grants:

- **Client credentials** — the application acts as itself. This is how Entra ID issues tokens
  for Power BI, Microsoft Fabric, Azure Resource Manager and Microsoft Graph in a national
  cloud.
- **Refresh token** — the application acts for one user who signed in once, outside vaultgate,
  and whose refresh token you keep in the vault. This is how Zoho Books, HubSpot (public apps)
  and Xero work.

Keep `graph` for Microsoft Graph on `https://graph.microsoft.com`. An API that gives you a
long-lived key or token instead (a HubSpot private app, most "API key" products) needs no token
endpoint: use `bearer` or `header`.

### The fields

The form draws every mode's fields at once and reads only those of the chosen mode; these are
the ones the `oauth2` mode reads.

| Form field                         | Document field        | What it is                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Injection mode**                 | `mode`                | `oauth2`.                                                                                                                                                                                                                                                        |
| **Token endpoint URL (oauth2)**    | `token_url`           | The provider's token endpoint. `https://` only — never `http://`, not even on an internal target, because the client secret is sent to it — and no query string, fragment or `user:password@`.                                                                   |
| **Application (client) id**        | `client_id`           | The client id the provider issued: a GUID for Entra ID, `1000.…` for Zoho, and so on. It is not a secret; 1 to 512 printable characters without spaces.                                                                                                          |
| **Client authentication (oauth2)** | `client_auth`         | `post` (the default): the client id and secret travel in the form body. `basic`: they travel as HTTP Basic credentials (RFC 6749 §2.3.1) and not in the body. Use what the provider documents; Xero wants `basic`.                                               |
| **Grant**                          | `grant`               | `client_credentials` or `refresh_token`.                                                                                                                                                                                                                         |
| **Scope**                          | `scope`               | Optional; sent only when set. For Entra ID client credentials it is the resource's `/.default` scope. A refresh-token grant usually needs none: the refresh token carries its scopes.                                                                            |
| **Client secret field**            | `secret_field`        | The vault field holding the client secret; a hidden custom field is the natural home.                                                                                                                                                                            |
| **Refresh token field**            | `refresh_token_field` | For the refresh-token grant only (required there, refused for client credentials): the vault field holding the refresh token, a hidden custom field of the same item. vaultgate writes a new one back here.                                                      |
| **Header or query parameter name** | `name`                | The header the token goes in. Leave it blank for `authorization`.                                                                                                                                                                                                |
| **Value prefix**                   | `prefix`              | What is written before the token. Leave it blank for `Bearer` and a space; Zoho wants `Zoho-oauthtoken` and a space — type the trailing space, the form keeps it. A blank field always means the default, so the form cannot send a token with no prefix at all. |

The **Base URL** is any `http` destination, a private trust included, and the policy is an
ordinary `http` policy.

**Saving checks**, without connecting to anything: the shape of every field above; that the
vault item carries the client secret field and, for the refresh grant, the refresh token field;
and the token endpoint's host by the same private-range rule as the destination's — so a token
endpoint on a private address needs **Internal destination** ticked, exactly as a private base URL
does. **Check without saving** lists the token endpoint's host and the address it resolves to
under the destination's.

### What happens on a call

1. **A token, from the cache or the endpoint.** A token vaultgate already holds for this target
   is used until sixty seconds before it expires. Otherwise vaultgate posts the grant to the
   token URL through the same pinned transport as the request, after resolving the token host
   and checking it against the private-range rule for the target's **Internal destination**
   setting. The form carries `grant_type`, the refresh token for that grant and the scope only
   when you set one, plus the client id and secret unless client authentication is `basic`.
2. **The answer.** A token response is read up to 64 KiB and checked before anything is taken
   from it. `expires_in` may be a number or a quoted number; when the endpoint does not say,
   vaultgate assumes 300 seconds, so it uses such a token for four minutes and then asks again.
   `token_type` is ignored: your prefix decides what the header says.
3. **Rotation.** If the endpoint returns a refresh token different from the one in the vault,
   vaultgate writes it back into the refresh token field **before** it calls the API and records
   an `actions.credential_rotated` event (target, item and field; never the value). An endpoint
   that returns the same refresh token, or none, causes no write and no event.
4. **The request.** The token goes in as `<name>: <prefix><token>` — on the request and on every
   redirect hop vaultgate follows under the base URL. Whatever **Allowed request headers** says,
   an agent can never set that header itself, nor `Authorization`.
5. **A `401` from the API** discards the cached token and the request is retried once with a
   fresh one; a second `401` is returned as the result.

The token lives in process memory only, keyed by the target and its revision: it is never
stored, never logged, and redacted from every result as `[redacted:oauth2.access_token]`.
Editing the target, or restarting vaultgate, means the next call asks the endpoint for a new one.

### Power BI REST API

**In Entra ID.** Register an application, note its **Directory (tenant) ID** and **Application
(client) ID**, and create a client secret. No API permission is needed for this: the service
principal's access comes from Power BI.

**In Power BI.** In the Fabric admin portal, allow service principals to use the Fabric and
Power BI APIs for a security group that contains the application, then add the application to
each workspace the agent may use, with the least role that suffices (Viewer to read, Contributor
to refresh datasets).

**The target.**

- **Base URL:** `https://api.powerbi.com/v1.0/myorg`
- **Credential mapping:**

  ```json
  {
    "mode": "oauth2",
    "token_url": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token",
    "grant": "client_credentials",
    "client_id": "<application-id>",
    "scope": "https://analysis.windows.net/powerbi/api/.default",
    "secret_field": "custom.client-secret"
  }
  ```

- **Allowed paths**, for example: `/groups`, `/groups/*/reports`, `/groups/*/datasets`,
  `/groups/*/datasets/*/refreshes` (and `POST` in **Allowed methods** only if the agent may
  trigger a refresh).

### Microsoft Fabric REST API

As for Power BI — the same application, tenant setting and workspace roles — with:

- **Base URL:** `https://api.fabric.microsoft.com/v1`
- **Scope:** `https://api.fabric.microsoft.com/.default`, the rest of the mapping as above.
- **Allowed paths**, for example: `/workspaces`, `/workspaces/*`, `/workspaces/*/items`,
  `/workspaces/*/items/*`, and `/operations/*` with `/operations/*/result` if the agent polls
  long-running operations.
- **Returned response headers:** add `x-ms-operation-id` to the defaults (`location` and
  `retry-after` are already there) so the agent can follow a `202 Accepted`.

### Azure Resource Manager

**In Azure.** Give the application's service principal a role assignment at the narrowest scope
that covers the work — for example **Reader** on one resource group.

- **Base URL:** `https://management.azure.com`
- **Scope:** `https://management.azure.com/.default`, with the tenant token URL, client
  credentials and client secret field as above.
- **Allowed paths:** every Resource Manager request carries an `api-version` in its query, and
  patterns match the path and query together, so write them with it, for example
  `/subscriptions?api-version=*`, `/subscriptions/*/resourcegroups?api-version=*` and
  `/subscriptions/*/resourceGroups/*/providers/**`. Resource Manager treats paths
  case-insensitively but patterns are literal: use the casing your agent sends.
- Keep **Allowed methods** at `GET` and `HEAD` for a read-only target.

### Microsoft Graph in a national cloud

The `graph` mode is fixed to the global service. For a national cloud, use `oauth2` with that
cloud's sign-in host and Graph origin — for US Government, token URL
`https://login.microsoftonline.us/<tenant-id>/oauth2/v2.0/token`, base URL
`https://graph.microsoft.us/v1.0` and scope `https://graph.microsoft.us/.default`; for the
cloud operated by 21Vianet, `https://login.chinacloudapi.cn/<tenant-id>/oauth2/v2.0/token`,
`https://microsoftgraph.chinacloudapi.cn/v1.0` and
`https://microsoftgraph.chinacloudapi.cn/.default`.

### Zoho Books

Zoho runs separate data centres, and an account lives in one of them: its accounts server
(`accounts.zoho.com`, `accounts.zoho.eu`, `accounts.zoho.in`, `accounts.zoho.com.au`, and so on)
issues the tokens, and its API host (`www.zohoapis.com`, `www.zohoapis.eu`, …) serves the API.
Use the pair that matches the organisation's region throughout.

**In Zoho.** In the API console of the right data centre, create a client (a self client is the
simplest), generate a grant code for the scopes the agent needs — for example
`ZohoBooks.invoices.READ,ZohoBooks.contacts.READ` — and exchange it once, outside vaultgate, for
a refresh token. Put the client secret and the refresh token in two hidden custom fields of one
vault item.

- **Base URL:** `https://www.zohoapis.eu/books/v3` (the API host of the organisation's region).
- **Credential mapping:**

  ```json
  {
    "mode": "oauth2",
    "token_url": "https://accounts.zoho.eu/oauth/v2/token",
    "grant": "refresh_token",
    "client_id": "1000.<client-id>",
    "secret_field": "custom.client-secret",
    "refresh_token_field": "custom.refresh-token",
    "prefix": "Zoho-oauthtoken "
  }
  ```

  Zoho wants `Authorization: Zoho-oauthtoken <token>`, not `Bearer`: type the prefix with its
  trailing space. Leave the scope empty; the refresh token carries it. Zoho's documentation shows
  the token parameters in the query string; vaultgate sends them in the form body, which Zoho
  accepts, and refuses a token URL with a query.

- **Allowed paths:** every Books call names the organisation in the query
  (`?organization_id=<id>`), so write patterns with a query, for example `/invoices?*`,
  `/invoices/*?*`, `/contacts?*` and `/contacts/*?*`.

Zoho never rotates the refresh token, so vaultgate never writes to the vault for it, and another
tool may share the same refresh token. Zoho does limit how many access tokens a refresh token may
mint in a short window: vaultgate's cache keeps it to about one an hour per target, but every
edit of the target and every restart mints a new one, so avoid a burst of them. A refused refresh
token comes back as HTTP 200 with `{"error":"invalid_code"}`, which vaultgate reports as
`authentication_failed` with `detail.error: invalid_code`.

### HubSpot

For a public app that uses OAuth (a private app's token is a static one: use `bearer`):

- **Base URL:** `https://api.hubapi.com`
- **Credential mapping:** `token_url` `https://api.hubapi.com/oauth/v1/token`, grant
  `refresh_token`, the app's client id, client authentication `post`, and the client secret and
  refresh token fields; name and prefix left blank.
- **Allowed paths**, for example: `/crm/v3/objects/contacts`, `/crm/v3/objects/contacts/*`,
  `/crm/v3/objects/deals?*`.

HubSpot answers a refresh with the same refresh token, so nothing is written back. Its token
endpoint may report a failure in its own shape (a `status` such as `BAD_REFRESH_TOKEN` rather
than an OAuth `error` code), which vaultgate passes on as `upstream_error` with the HTTP status
alone.

### Xero

- **Base URL:** `https://api.xero.com/api.xro/2.0`
- **Credential mapping:** `token_url` `https://identity.xero.com/connect/token`, grant
  `refresh_token`, client authentication **`basic`**, the app's client id, and the client secret
  and refresh token fields.
- **Allowed request headers:** add `xero-tenant-id` — every Accounting API call names the
  organisation in it, and the agent supplies it.
- **Allowed paths**, for example: `/Invoices`, `/Invoices/*`, `/Contacts`, `/Contacts/*`.

Obtain the first refresh token once, outside vaultgate, through Xero's authorisation-code flow
with the `offline_access` scope. Xero rotates refresh tokens on every refresh, so vaultgate
writes each new one back to the vault before it calls the API: the mapped field must be one
vaultgate can write (a custom field, the login password or the notes) and the vault must be
unlocked. Do not use the same refresh token from any other tool — whichever refreshes first
leaves the other holding a spent token. A Xero refresh token also expires when unused for a
while (60 days at the time of writing), so a target nobody calls needs re-authorising.

### Errors

At save (every problem is listed, with what you typed):

| Problem                                                                                                  | Meaning                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credential.mapping.token_url: must be an https:// URL, even on an internal target: …`                   | The token URL is `http://` (or another scheme). Use the provider's `https://` endpoint.                                                          |
| `credential.mapping.token_url: must not carry a query string or fragment` / `must not carry credentials` | Drop the query, fragment or `user:password@`; the parameters travel in the form body.                                                            |
| `credential.mapping.client_id: must be 1 to 512 printable characters, no spaces`                         | The client id is empty, too long, or has a space or a non-ASCII character in it.                                                                 |
| `credential.mapping: refresh_token_field is required for the refresh_token grant`                        | Map the refresh token field, or choose the client-credentials grant.                                                                             |
| `credential.mapping: refresh_token_field is used by the refresh_token grant only; remove it`             | Clear the refresh token field on a client-credentials target, so its value is never fetched.                                                     |
| `credential.mapping: the item has no "custom.…" field`                                                   | The vault item lacks the client secret or refresh token field you named.                                                                         |
| `credential.mapping: host "…" is a private-range address; set internal: true to allow it`                | The token endpoint resolves to a private address; tick **Internal destination** if that is intended. Loopback and link-local are refused always. |
| `credential.mapping: host "…" does not resolve to any address`                                           | A typo in the token URL's host, or a name this deployment's resolver does not know.                                                              |

On a call (the call history records the code and detail too):

| Code                                                               | Detail                                                             | Meaning and what to do                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication_failed`                                            | `error: invalid_client`                                            | The client id or secret is wrong or expired, or the client authentication (`post` or `basic`) is not the one the provider expects; with Zoho, often a client of another data centre.                                                                                                        |
| `authentication_failed`                                            | `error: invalid_grant`                                             | The refresh token is spent, revoked or expired (for Xero, perhaps used by another tool first). Sign in again outside vaultgate and put the new refresh token in the vault.                                                                                                                  |
| `authentication_failed`                                            | `error: unauthorized_client`                                       | The client may not use this grant; for Entra ID, the application is not in that tenant.                                                                                                                                                                                                     |
| `authentication_failed`                                            | `error: invalid_code`                                              | Zoho refused the refresh token (revoked, or from another data centre).                                                                                                                                                                                                                      |
| `upstream_error`                                                   | `status`, and `error` when the endpoint sent a well-formed one     | The endpoint refused for another reason — `invalid_scope` usually means the scope is wrong (Entra ID client credentials need the resource's `/.default`). A body without an OAuth error code gives the status alone. The error's description is never passed on: it can repeat the request. |
| `upstream_error`                                                   | `reason: invalid_token_response`                                   | The endpoint answered 2xx with something that is not a token — usually a token URL that points at the wrong page.                                                                                                                                                                           |
| `credential_rotation_failed`                                       | `reason` (`vault_unavailable`, `not_found`, `unwritable_field`, …) | The new refresh token could not be written back, so the API was not called. Unlock the vault or map a writable field, and act quickly: a provider that revokes a used refresh token (Xero) leaves the stored one spent.                                                                     |
| `credential_unavailable`                                           | —                                                                  | The vault is locked, or the item lacks a mapped field; the target's page says which.                                                                                                                                                                                                        |
| `destination_refused`, `connection_failed`, `tls_error`, `timeout` | `reason`                                                           | The token endpoint (or the API) could not be reached or refused by the private-range rule, as for any destination.                                                                                                                                                                          |
| result `status: 401`                                               | —                                                                  | The API refused a fresh token too: the token is valid but not enough — a missing workspace role or RBAC assignment, the wrong scope, or the wrong header name or prefix.                                                                                                                    |
| `policy_denied`                                                    | `reason: header`                                                   | The agent tried to set the header the token occupies (or `Authorization`); it never may.                                                                                                                                                                                                    |
