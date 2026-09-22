import { hidden, type Html, html, when } from '../identity/pages/template.ts';

import type { ConnectedClient } from './repositories/consents.ts';

export const CONSENT_REVOKE_PATH = '/oauth/consents/:id/revoke' as const;

/**
The anchor of the account page's re-authentication form (ID-15).
*/
const REAUTHENTICATION_ANCHOR = '/account#sensitive-actions';

/**
What the section needs from the session (a `SessionState` satisfies it).
*/
export interface ConnectedClientsView {
  readonly csrfToken: string;
  /**
  ID-15: the Disconnect forms exist only inside the re-authentication window.
  */
  readonly isReauthenticated: boolean;
}

function revokePath(consentId: string): string {
  return `/oauth/consents/${encodeURIComponent(consentId)}/revoke`;
}

function revokeForm(client: ConnectedClient, csrfToken: string): Html {
  return html`<form method="post" action="${revokePath(client.id)}">
    ${hidden('csrf', csrfToken)}
    <button type="submit">Disconnect</button>
  </form>`;
}

function row(client: ConnectedClient, view: ConnectedClientsView): Html {
  const lastUsed =
    client.lastUsedAt === undefined ? 'never' : new Date(client.lastUsedAt).toISOString();
  return html`<tr>
    <td>${client.clientName ?? client.clientId}</td>
    <td>${client.scopes.join(' ')}</td>
    <td>${new Date(client.grantedAt).toISOString()}</td>
    <td>${lastUsed}</td>
    <td>${when(view.isReauthenticated, () => revokeForm(client, view.csrfToken))}</td>
  </tr>`;
}

/**
 * OAUTH-30: the account page's connected clients with their last-used time
 * and, once the password has been confirmed (ID-15), a revoke form per
 * consent; until then a note pointing at the re-authentication form.
 */
export function renderConnectedClients(
  clients: readonly ConnectedClient[],
  view: ConnectedClientsView,
): Html {
  return html`${when(clients.length === 0, () => html`<p>No clients are connected.</p>`)}
  ${when(
    clients.length > 0 && !view.isReauthenticated,
    () =>
      html`<p>
        To disconnect a client, first
        <a href="${REAUTHENTICATION_ANCHOR}">confirm your password</a> under Sensitive actions.
      </p>`,
  )}
  ${when(
    clients.length > 0,
    () =>
      html`<table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Permissions</th>
            <th>Connected</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${clients.map((client) => row(client, view))}
        </tbody>
      </table>`,
  )}`;
}
