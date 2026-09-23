import { cell, hidden, type Html, html, tableHead, when } from './template.ts';

import type { VaultConnectionStatus, VaultCredentialOrigin } from '../../vault/connection.ts';

/**
The non-secret fields as last submitted, so a failed attempt does not empty the form.
*/
export interface VaultFormValues {
  readonly serverUrl: string;
  readonly clientId: string;
}

export const EMPTY_VAULT_FORM: VaultFormValues = { serverUrl: '', clientId: '' };

export interface VaultConnectionView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly vault: VaultConnectionStatus;
  readonly vaultForm: VaultFormValues;
}

const ORIGIN_TEXT: Readonly<Record<VaultCredentialOrigin, string>> = {
  settings: 'configured on this page',
  environment: 'seeded from the environment; saving here takes over',
  none: 'not configured',
};

const STATUS_COLUMNS = ['Setting', 'Value'] as const;

function statusRow(label: string, value: string): Html {
  return html`<tr>
    ${cell(STATUS_COLUMNS[0], label)} ${cell(STATUS_COLUMNS[1], value)}
  </tr>`;
}

function statusTable(status: VaultConnectionStatus): Html {
  const rows = [
    statusRow('Connection', ORIGIN_TEXT[status.origin]),
    statusRow('Server', status.serverUrl),
    statusRow('Account', status.userEmailMasked ?? 'unknown until the vault is ready'),
    statusRow('Ready', status.ready ? 'yes' : 'no'),
    statusRow('Last sync', status.lastSyncAt ?? 'none since start-up'),
  ];
  return html`<table>
    ${tableHead(STATUS_COLUMNS)}
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function connectionForm(view: VaultConnectionView): Html {
  const keepNote = when(
    view.vault.configured,
    () => html` Leave a secret blank to keep the one in use.`,
  );
  return html`<form method="post" action="/account/vault">
    ${hidden('csrf', view.csrfToken)}
    <label
      >Server (optional)
      <input
        name="server_url"
        inputmode="url"
        placeholder="https://vault.bitwarden.com"
        value="${view.vaultForm.serverUrl}"
      />
    </label>
    <p>
      Leave empty for bitwarden.com. Enter <code>bitwarden.eu</code> for the EU cloud, or the
      <code>https://</code> address of a self-hosted Bitwarden or Vaultwarden server.
    </p>
    <label
      >API key client id
      <input name="client_id" required autocomplete="off" value="${view.vaultForm.clientId}" />
    </label>
    <label
      >API key client secret
      <input name="client_secret" type="password" autocomplete="off" />
    </label>
    <label
      >Master password
      <input name="master_password" type="password" autocomplete="off" />
    </label>
    <p>Secrets are never shown here.${keepNote}</p>
    <button type="submit">Save and connect</button>
  </form>`;
}

/**
 * The account page's "Vault connection" section (ID-25, VAULT-18): the
 * status for everyone signed in, the form only after a fresh password
 * confirmation (ID-15). Saving is the test: the backend switches to the new
 * connection and the outcome comes back on this page.
 */
export function vaultConnectionSection(view: VaultConnectionView): Html {
  return html`<section id="vault">
    <h3>Vault connection</h3>
    ${statusTable(view.vault)}
    ${when(
      !view.isReauthenticated,
      () => html`<p>Confirm your password above to change the vault connection.</p>`,
    )}
    ${when(view.isReauthenticated, () => connectionForm(view))}
  </section>`;
}
