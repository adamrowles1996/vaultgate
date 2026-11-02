# Connect ChatGPT

ChatGPT uses remote MCP servers through plugins. Add vaultgate as a custom MCP server, which
signs in as you create it; optionally, also upload the plugin package in
[`deploy/chatgpt-plugin/`](../../deploy/chatgpt-plugin), which adds a skill that teaches ChatGPT
to use actions rather than read secrets, and the vaultgate icon. The flows are OpenAI's
([Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Package your plugin](https://developers.openai.com/plugins/build/plugins)); where they and
this page differ, OpenAI's documentation wins.

## Before you start

- vaultgate is installed, `/readyz` returns `200`, and you have completed [First run](first-run.md).
- vaultgate is a release after 0.1.0-rc.26. Earlier releases refuse ChatGPT's client metadata
  document (see [How ChatGPT identifies itself](#how-chatgpt-identifies-itself)).
- `https://<host>/mcp` is reachable from the public internet. ChatGPT connects from OpenAI's
  infrastructure, not from your browser, exactly as Claude does from Anthropic's
  ([Connect Claude](connect-claude.md#before-you-start)).
- In a ChatGPT workspace, your role needs **Create plugins with MCPs** to add a server, and
  **Upload plugins** with **Upload plugins with custom MCP servers** to upload the package. A
  workspace owner sets them under **Permissions & roles**.

## Add the server

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add
   custom MCP server**.
2. Enter the name `vaultgate`, a description, and the server URL `https://<host>/mcp`.
3. Choose **OAuth** for authentication. Leave any client id and secret empty: ChatGPT
   identifies itself, and vaultgate issues no client secrets. Review the risk warning and select
   **I understand and want to continue**.
4. Select **Create as a plugin**. Your browser goes to vaultgate's login page, then the consent
   page.
5. On the consent page, check that **Will redirect to** names `chatgpt.com`, then tick the
   scopes ChatGPT should have. ChatGPT follows the `401` challenge's `scope="vault:read"` hint,
   so the other enabled scopes, every `actions:*` scope included, are listed unticked under
   **Not requested**. Tick the actions scopes you want ChatGPT to use; without one it has no
   actions tools.
6. Grant targets to the new client on the console's **Agents** page. A newly connected agent has
   no grants, so `actions_list_targets` returns nothing until you give it some.
7. In ChatGPT, open your personal plugins, install vaultgate, start a new chat, type `@`, choose
   vaultgate, and ask it to list the targets it can use.

Choosing scopes, tokens and revoking work as in [Connect Claude](connect-claude.md#choosing-scopes).
A workspace admin can publish the plugin to selected roles from **Personal** → **…** →
**Publish**; each member then connects with their own vaultgate sign-in.

## How ChatGPT identifies itself

ChatGPT prefers a Client ID Metadata Document whenever the server advertises support, as
vaultgate does: its `client_id` is `https://chatgpt.com/oauth/client.json`, and the consent page
shows it as _identified by its client metadata document (URL client id)_. That document lists
`none` and `private_key_jwt` in `token_endpoint_auth_methods_supported` and names
`private_key_jwt` as its singular `token_endpoint_auth_method` preference (MCP SEP-3149).
vaultgate supports public clients only, so ChatGPT uses `none`, the one method both sides
support. Releases up to 0.1.0-rc.26 read the singular field as binding and refused the document
with `invalid_client`; later releases decide by the list (spec 03, OAUTH-5).

## The plugin package

The package bundles the server with the `use-vaultgate` skill. Build it for your deployment from
a clone of this repository, passing the deployment's `VAULTGATE_PUBLIC_URL`:

```bash
scripts/chatgpt-plugin.sh https://vaultgate.example.com
```

The script writes `vaultgate-chatgpt-plugin.zip` (a second argument names another path). It
copies the template, sets the server URL in `mcp.json` to `<public-url>/mcp` and the version in
`plugin.json` to this release's, and zips the result with `plugin.json` at the root:

```text
plugin.json                    identity and listing: name, description, icons, starter prompts
mcp.json                       the vaultgate server URL
skills/use-vaultgate/SKILL.md  how to choose between actions, metadata and get_secret
assets/icon.png, logo.png      the vaultgate mark
```

Without the script, edit the `url` in `deploy/chatgpt-plugin/mcp.json` and zip the folder's
contents (not the folder itself). The ZIP holds no secret. Upload it from the plus button at
[ChatGPT Plugins](https://chatgpt.com/plugins), install it, and connect when ChatGPT asks; the
sign-in and consent are as in [Add the server](#add-the-server). Rebuild and upload it when
`deploy/chatgpt-plugin/` changes or the public URL moves.

## Updating

A vaultgate upgrade needs nothing on the ChatGPT side, because ChatGPT reads the tool list from
the server; if it shows a stale list, select **Refresh** on the connection at
[ChatGPT Plugins](https://chatgpt.com/plugins).

## Troubleshooting

- **The uploaded package offers no way to sign in, or is marked Desktop only.** ChatGPT applies
  that label to some uploaded plugins that declare MCP servers. Use
  [Add the server](#add-the-server) instead.
- **`invalid_client`: "client metadata is invalid" on vaultgate's authorize page.** The
  deployment is 0.1.0-rc.26 or earlier. Upgrade ([Upgrading](upgrading.md)) and connect again.
- **A `401` loop, `insufficient_scope`, or tools missing after connecting.** As in
  [Connect Claude § Troubleshooting](connect-claude.md#troubleshooting).
