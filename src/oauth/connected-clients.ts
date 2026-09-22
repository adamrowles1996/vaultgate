import { hidden, type Html, html, when } from '../identity/pages/template.ts';

import type { ConnectedClient } from './repositories/consents.ts';

export const CONSENT_REVOKE_PATH = '/oauth/consents/:id/revoke' as const;

function revokePath(consentId: string): string {
  return `/oauth/consents/${encodeURIComponent(consentId)}/revoke`;
}

function row(client: ConnectedClient, csrfToken: string): Html {
  const lastUsed =
    client.lastUsedAt === undefined ? 'never' : new Date(client.lastUsedAt).toISOString();
  return html`<tr>
    <td>${client.clientName ?? client.clientId}</td>
    <td>${client.scopes.join(' ')}</td>
    <td>${new Date(client.grantedAt).toISOString()}</td>
    <td>${lastUsed}</td>
    <td>
      <form method="post" action="${revokePath(client.id)}">
        ${hidden('csrf', csrfToken)}
        <button type="submit">Disconnect</button>
      </form>
    </td>
  </tr>`;
}

/**
 * OAUTH-30: the account page's connected clients with their last-used time
 * and a revoke form per consent, guarded like every other account action.
 */
export function renderConnectedClients(
  clients: readonly ConnectedClient[],
  csrfToken: string,
): Html {
  return html`${when(clients.length === 0, () => html`<p>No clients are connected.</p>`)}
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
          ${clients.map((client) => row(client, csrfToken))}
        </tbody>
      </table>`,
  )}`;
}
