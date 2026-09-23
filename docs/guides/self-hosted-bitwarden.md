# Self-hosted Bitwarden, bitwarden.eu and Vaultwarden

vaultgate reaches the vault through the Bitwarden CLI, so it works with every server the CLI
works with: bitwarden.com (US), bitwarden.eu, a self-hosted Bitwarden server and Vaultwarden.
The only difference is the server field of the vault connection. Specification:
[05 Vault backend](../spec/05-vault-backend.md) and [12 § 12.3](../spec/12-compatibility.md).

## The server

Enter it in the **Server** field of the account page's vault connection
([First run, section 6](first-run.md#6-connect-the-vault)), or as `VAULTGATE_BW_SERVER` when
seeding the first boot from the environment:

| Server                | Value                                    |
| --------------------- | ---------------------------------------- |
| bitwarden.com (US)    | leave empty (an empty value means unset) |
| bitwarden.eu          | `bitwarden.eu`                           |
| Self-hosted Bitwarden | `https://vault.example.com`              |
| Vaultwarden           | `https://vault.example.com`              |

Anything else is rejected, by the form and at start-up alike: the value must be the literal
`bitwarden.eu` or an `https://` URL. Plain `http://` is not accepted, because the CLI would send
the master password to that address.

Before a login vaultgate runs `bw config server <value>` (or `bw config server bitwarden.com`
to reset a reused CLI directory to the default) and then `bw login --apikey`. Saving the form
with a different server switches at once: the new connection logs in inside a fresh CLI app-data
directory and the old one is retired, so moving an installation to another server is one save,
with no restart and nothing to delete by hand.

## Creating a personal API key

The API key identifies the account to the server without a browser, a second factor or a
new-device e-mail. In the web vault:

1. Sign in and open **Settings → Security → Keys**.
2. Under **API key**, click **View API key** and confirm your master password.
3. Copy `client_id` (`user.` followed by a UUID) and `client_secret` into the account page's
   vault connection (or, to seed the first boot, into `VAULTGATE_BW_CLIENT_ID` and
   `VAULTGATE_BW_CLIENT_SECRET`, the latter also through `VAULTGATE_BW_CLIENT_SECRET_FILE`).

The same page has **Rotate API key**. Rotating invalidates the old key everywhere it is used:
enter the new client id and secret on the account page, leave the master password blank, and
save. The CLI logs in again with the new key in a fresh directory; nothing to delete, no restart.

Vaultwarden serves Bitwarden's web vault, so the path is the same there.

## Why the API key and the master password are both needed

Bitwarden is end-to-end encrypted. The server never holds the key that decrypts your items; that
key is derived from the master password on the client. So two different things are required:

- **The API key** authenticates the _account_: it lets the CLI log in and download the encrypted
  vault, and it does so without the interactive prompts (two-factor codes, new-device
  verification e-mails) that a headless process could never answer.
- **The master password** unlocks the _data_: the CLI derives the encryption key from it and
  decrypts the downloaded vault in memory.

Neither one alone gives access. Both are kept in the vaultgate process's memory for the
connection in use, zero-filled when it is replaced or on shutdown, and never logged. When saved
on the account page they are also stored in the database as AES-256-GCM ciphertext under keys
derived from `VAULTGATE_SECRET_KEY`, which is why that key is backed up separately from the
database ([security model](security-model.md)). The CLI's own session key stays inside the
`bw serve` child process on loopback.

Bitwarden's [personal API key documentation](https://bitwarden.com/help/personal-api-key/)
describes the key and its rotation in more detail.

## Vaultwarden notes

- **The account must exist first.** vaultgate never creates an account; it logs in to one. Create
  the account in the Vaultwarden web vault, or let an invited user accept the invitation, before
  starting vaultgate. Once the account exists, most operators set `SIGNUPS_ALLOWED=false` on
  Vaultwarden and invite further users from the admin page.
- **A personal API key is required**, exactly as for bitwarden.com: Settings → Security → Keys
  in the Vaultwarden web vault. Vaultwarden's admin token is unrelated and must not be used.
- **`DOMAIN` must be set** on Vaultwarden to the `https://` origin it is served at, and the
  server in vaultgate must be that same origin. The CLI derives the API, identity and
  notification endpoints from it.
- **Organisations and collections** work the same way as on Bitwarden: `list_collections` shows
  the collections the account can see, and `search_items` filters by `collection_id`.
- **A dedicated account is a good idea.** Make a separate Vaultwarden (or Bitwarden) user for
  vaultgate, share only the collections agents should reach into it, and keep your personal
  account out of the loop. That bounds what any token can ever see.

## Self-hosted Bitwarden notes

- Set the server to the base URL of the installation, the same one you open in a browser. The
  CLI derives the individual service endpoints from it.
- If your server uses a private certificate authority, the CLI (a Node application) must trust
  it. In the container that means mounting the CA and setting `NODE_EXTRA_CA_CERTS` for the
  process; on a Linux install, add the CA to the system store or set the same variable in
  `/etc/vaultgate/vaultgate.env`.
- Organisation policies that require single sign-on or disable personal vaults apply to the
  account vaultgate uses like any other; an account that cannot log in with an API key cannot be
  used.

## Checking

With the vault ready, `vault_status` reports the `server_url` the CLI is using and the masked
account e-mail, so a first tool call confirms which server and which account you are connected
to. The start-up log line `bitwarden cli version` confirms the CLI in use; the minimum version is
2025.1.0, and older versions are refused.
