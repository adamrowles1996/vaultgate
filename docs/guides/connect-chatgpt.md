# Connect ChatGPT

ChatGPT uses remote MCP servers through plugins. vaultgate ships a plugin package for this in
[`deploy/chatgpt-plugin/`](../../deploy/chatgpt-plugin): the server connection, one skill that
teaches ChatGPT to use actions rather than read secrets, and the vaultgate icon. You build a ZIP
of it for your own deployment and upload that to ChatGPT. The package format and upload flow are
OpenAI's ([Package your plugin](https://developers.openai.com/plugins/build/plugins),
[Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)); where they
and this page differ, OpenAI's documentation wins.

## Before you start

- vaultgate is installed, `/readyz` returns `200`, and you have completed [First run](first-run.md).
- `https://<host>/mcp` is reachable from the public internet. ChatGPT connects from OpenAI's
  infrastructure, not from your browser, exactly as Claude does from Anthropic's
  ([Connect Claude](connect-claude.md#before-you-start)).
- In a ChatGPT workspace, your role has **Upload plugins** and **Upload plugins with custom MCP
  servers**. A workspace owner sets them under **Permissions & roles**.

## Build the ZIP

From a clone of this repository, pass the deployment's `VAULTGATE_PUBLIC_URL`:

```bash
scripts/chatgpt-plugin.sh https://vaultgate.example.com
```

The script writes `vaultgate-chatgpt-plugin.zip` (a second argument names another path). It
copies the template, sets the server URL in `mcp.json` to `<public-url>/mcp` and the version in
`plugin.json` to this release's, and zips the result with `plugin.json` at the root:

```text
plugin.json                    identity and listing: name, description, icons, starter prompts
mcp.json                       the vaultgate server: URL and OAuth settings
skills/use-vaultgate/SKILL.md  how to choose between actions, metadata and get_secret
assets/icon.png, logo.png      the vaultgate mark
```

Without the script, edit the `url` in `deploy/chatgpt-plugin/mcp.json` and zip the folder's
contents (not the folder itself). The ZIP holds no secret: ChatGPT signs in through vaultgate's
own login and consent pages.

## Why `mcp.json` asks for dynamic registration

`mcp.json` sets `extensions["com.openai"].auth.client.mode` to `dcr`. Left to choose, ChatGPT
prefers a Client ID Metadata Document whenever the server advertises support, as vaultgate does.
ChatGPT's document (`https://chatgpt.com/oauth/client.json`) lists `none` among its
`token_endpoint_auth_methods_supported` but also sets the singular
`token_endpoint_auth_method` to `private_key_jwt`, and vaultgate, which supports public clients
only, refuses a document whose singular method is not `none` (spec 03, OAUTH-9). Dynamic
registration avoids that: ChatGPT registers itself as a public client, which vaultgate accepts,
and the consent page shows it as _registered dynamically; nobody has vetted this client_. Check
that **Will redirect to** names `chatgpt.com` before you allow it.

## Upload and connect

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button and upload the ZIP.
2. Install the plugin and connect it when ChatGPT asks. Your browser goes to vaultgate's login
   page, then the consent page.
3. On the consent page, tick the scopes ChatGPT should have. ChatGPT follows the `401`
   challenge's `scope="vault:read"` hint, so the other enabled scopes, every `actions:*` scope
   included, are listed unticked under **Not requested**. Tick the actions scopes you want
   ChatGPT to use; without one it has no actions tools.
4. Grant targets to the new client on the console's **Agents** page. A newly connected agent has
   no grants, so `actions_list_targets` returns nothing until you give it some.
5. Start a new chat, type `@`, choose vaultgate, and ask it to list the targets it can use.

Choosing scopes, tokens and revoking work as in [Connect Claude](connect-claude.md#choosing-scopes).
A workspace admin can publish the plugin to selected roles from **Personal** → **…** →
**Publish**; each member then connects with their own vaultgate sign-in.

## Updating

Rebuild and upload the ZIP when `deploy/chatgpt-plugin/` changes or the public URL moves. A
vaultgate upgrade needs no new ZIP, because ChatGPT reads the tool list from the server; if it
shows a stale list, select **Refresh** on the connection at
[ChatGPT Plugins](https://chatgpt.com/plugins).

## Troubleshooting

- **The plugin is marked Desktop only.** ChatGPT applies that label to some uploaded plugins
  that declare MCP servers. Add the server directly instead: Plugins → plus button → **Add
  custom MCP server**, URL `https://<host>/mcp`, OAuth, then **Create as a plugin**. Choose
  dynamic client registration if the form offers a choice, for the reason above.
- **`invalid_client`: "client metadata is invalid" on vaultgate's authorize page.** ChatGPT
  used its metadata document instead of dynamic registration. Check that the uploaded `mcp.json`
  still carries the `auth` block, then reconnect.
- **A `401` loop, `insufficient_scope`, or tools missing after connecting.** As in
  [Connect Claude § Troubleshooting](connect-claude.md#troubleshooting).
