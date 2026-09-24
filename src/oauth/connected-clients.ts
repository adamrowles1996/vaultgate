import {
  cell,
  EMPTY,
  hidden,
  type Html,
  html,
  tableHead,
  when,
} from '../identity/pages/template.ts';

import type { ConnectedClient } from './repositories/consents.ts';

export const CONSENT_REVOKE_PATH = '/oauth/consents/:id/revoke' as const;

/**
The anchor of the account page's re-authentication form (ID-15).
*/
const REAUTHENTICATION_ANCHOR = '/account#sensitive-actions';

/**
The last column holds the Disconnect form and has no heading.
*/
const COLUMNS = ['Client', 'Permissions', 'Connected', 'Last used', 'Targets', ''] as const;

/**
 * ACT-9: draws the action targets one client is granted, with the forms that
 * grant and revoke them, so an operator can manage a grant from this list as
 * well as from the target's page. Supplied by the composition layer only
 * when the actions layer is enabled; this module never imports it (ACT-70),
 * and without it the column stays empty.
 */
export type ClientTargetsRenderer = (clientId: string, view: ConnectedClientsView) => Html;

/**
What the section needs from the session (a `SessionState` satisfies it) plus the injected cell.
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

function row(
  client: ConnectedClient,
  view: ConnectedClientsView,
  targets: ClientTargetsRenderer,
): Html {
  const lastUsed =
    client.lastUsedAt === undefined ? 'never' : new Date(client.lastUsedAt).toISOString();
  return html`<tr>
    ${cell(COLUMNS[0], client.clientName ?? client.clientId)}
    ${cell(COLUMNS[1], client.scopes.join(' '))}
    ${cell(COLUMNS[2], new Date(client.grantedAt).toISOString())} ${cell(COLUMNS[3], lastUsed)}
    ${cell(COLUMNS[4], targets(client.clientId, view))}
    ${cell(
      COLUMNS[5],
      when(view.isReauthenticated, () => revokeForm(client, view.csrfToken)),
    )}
  </tr>`;
}

/**
The column a deployment without the actions layer draws: nothing at all.
*/
export const NO_CLIENT_TARGETS: ClientTargetsRenderer = () => EMPTY;

/**
 * OAUTH-30: the account page's connected clients with their last-used time,
 * the action targets each is granted (ACT-9) and, once the password has been
 * confirmed (ID-15), a revoke form per consent; until then a note pointing at
 * the re-authentication form.
 */
export function renderConnectedClients(
  clients: readonly ConnectedClient[],
  view: ConnectedClientsView,
  targets: ClientTargetsRenderer = NO_CLIENT_TARGETS,
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
        ${tableHead(COLUMNS)}
        <tbody>
          ${clients.map((client) => row(client, view, targets))}
        </tbody>
      </table>`,
  )}`;
}
