/**
 * The console's Vault page (ID-25, VAULT-18): the connection's status for
 * everyone signed in, the form that changes it only after a fresh password
 * confirmation (ID-15), and whatever other layers add below. Saving is the
 * test: the backend switches to the new connection and the outcome comes
 * back here. No secret is ever drawn; the secret fields always render empty.
 */
import { type ConsolePage, unlockPath } from './console.ts';
import { errorBanner, hidden, type Html, html, noticeBanner, when } from './template.ts';
import { cardHead, pageHead, pill, relativeTime } from './ui.ts';

import type { VaultConnectionStatus, VaultCredentialOrigin } from '../../vault/connection.ts';

/**
The non-secret fields as last submitted, so a failed attempt does not empty the form.
*/
export interface VaultFormValues {
  readonly serverUrl: string;
  readonly clientId: string;
}

export const EMPTY_VAULT_FORM: VaultFormValues = { serverUrl: '', clientId: '' };

export const VAULT_PATH = '/account/vault';

export interface VaultPageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly vault: VaultConnectionStatus;
  readonly vaultForm: VaultFormValues;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly now: number;
  /**
  The sections other layers add to this page, in order.
  */
  readonly sections: readonly Html[];
}

const ORIGIN_TEXT: Readonly<Record<VaultCredentialOrigin, string>> = {
  settings: 'configured on this page',
  environment: 'seeded from the environment; saving here takes over',
  none: 'not configured',
};

function stat(label: string, value: string | Html, sub: string | Html = ''): Html {
  return html`<div class="stat">
    <span class="stat-label">${label}</span><span class="stat-value">${value}</span
    ><span class="card-note">${sub}</span>
  </div>`;
}

function readiness(vault: VaultConnectionStatus): Html {
  if (!vault.configured) {
    return pill('off', 'Not connected');
  }
  return vault.ready ? pill('ok', 'Ready') : pill('warn', 'Not ready');
}

function statusCard(vault: VaultConnectionStatus, now: number): Html {
  const synced = vault.lastSyncAt === null ? '' : relativeTime(Date.parse(vault.lastSyncAt), now);
  return html`<section class="card stats" id="vault-status" aria-label="Vault status">
    ${stat('Status', readiness(vault), ORIGIN_TEXT[vault.origin])}
    ${stat('Server', html`<code>${vault.serverUrl}</code>`)}
    ${stat('Account', vault.userEmailMasked ?? 'unknown until the vault is ready')}
    ${stat('Last sync', vault.lastSyncAt ?? 'none since start-up', synced)}
  </section>`;
}

function connectionForm(view: VaultPageView): Html {
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
      <small
        >Leave empty for bitwarden.com. Enter <code>bitwarden.eu</code> for the EU cloud, or the
        <code>https://</code> address of a self-hosted Bitwarden or Vaultwarden server.</small
      >
    </label>
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
    <p class="card-note">Secrets are never shown here.${keepNote}</p>
    <button type="submit" class="primary">Save and connect</button>
  </form>`;
}

function connectionCard(view: VaultPageView): Html {
  return html`<section class="card" id="vault">
    ${cardHead(
      'Vault connection',
      'The Bitwarden or Vaultwarden account vaultgate signs in to, with its API key and master password.',
    )}
    ${when(
      !view.isReauthenticated,
      () =>
        html`<p>
          <a href="${unlockPath(VAULT_PATH)}">Confirm your password</a> to change the vault
          connection.
        </p>`,
    )}
    ${when(view.isReauthenticated, () => connectionForm(view))}
  </section>`;
}

export function vaultPage(view: VaultPageView): ConsolePage {
  const body = html`${pageHead(
    'Vault',
    'The account vaultgate signs in to. The vault stays the only store of secrets: pages show names, usernames and addresses, and a secret field only ever appears sealed.',
  )}
  ${errorBanner(view.error)} ${noticeBanner(view.notice)} ${statusCard(view.vault, view.now)}
  ${connectionCard(view)} ${view.sections}`;
  return {
    title: 'Vault',
    active: 'vault',
    crumbs: [{ label: 'Vault' }],
    body,
    returnTo: VAULT_PATH,
  };
}
