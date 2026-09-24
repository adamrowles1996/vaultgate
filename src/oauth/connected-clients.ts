import { unlockPath } from '../identity/pages/console.ts';
import { EMPTY, hidden, type Html, html, when } from '../identity/pages/template.ts';
import { formatInstant, monogram } from '../identity/pages/ui.ts';

import type { ConnectedClient } from './repositories/consents.ts';

export const CONSENT_REVOKE_PATH = '/oauth/consents/:id/revoke' as const;

/**
Where the Agents page sends an operator to confirm the password (ID-15) and come back.
*/
const AGENTS_PATH = '/account/agents';

/**
 * ACT-9: draws the action targets one client is granted, with the forms that
 * grant and revoke them, so an operator can manage a grant from this list as
 * well as from the target's page. Supplied by the composition layer only
 * when the actions layer is enabled; this module never imports it (ACT-70),
 * and without it the card has no computers row.
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
    <button type="submit" class="danger small">Disconnect</button>
  </form>`;
}

/**
The actions scopes are the ones that act on other systems (ACT-13), so they stand out.
*/
function scopeChip(scope: string): Html {
  const tone = scope.startsWith('actions:') ? 'tag-brass' : 'tag-plain';
  return html`<span class="tag ${tone} mono">${scope}</span>`;
}

function card(
  client: ConnectedClient,
  view: ConnectedClientsView,
  targets: ClientTargetsRenderer,
): Html {
  const name = client.clientName ?? client.clientId;
  const lastUsed =
    client.lastUsedAt === undefined
      ? 'not used yet'
      : `last used ${formatInstant(client.lastUsedAt)}`;
  return html`<article class="agent-card">
    <div class="cell-with-tile">
      ${monogram(client.clientId, name, 'large')}
      <div class="cell-main">
        <h3>${name}</h3>
        <span class="cell-sub">Connected ${formatInstant(client.grantedAt)}; ${lastUsed}</span>
      </div>
    </div>
    <div class="chips" aria-label="Permissions">
      ${client.scopes.map((scope) => scopeChip(scope))}
    </div>
    ${targets(client.clientId, view)}
    <div class="agent-foot">
      ${when(view.isReauthenticated, () => revokeForm(client, view.csrfToken))}
    </div>
  </article>`;
}

/**
The column a deployment without the actions layer draws: nothing at all.
*/
export const NO_CLIENT_TARGETS: ClientTargetsRenderer = () => EMPTY;

/**
 * OAUTH-30: the Agents page's connected clients, each with its permissions,
 * when it connected and was last used, the action targets it is granted
 * (ACT-9) and, once the password has been confirmed (ID-15), a Disconnect
 * form; until then a note that leads to confirming it.
 */
export function renderConnectedClients(
  clients: readonly ConnectedClient[],
  view: ConnectedClientsView,
  targets: ClientTargetsRenderer = NO_CLIENT_TARGETS,
): Html {
  return html`${when(clients.length === 0, () => html`<p class="empty">No clients are connected.</p>`)}
  ${when(
    clients.length > 0 && !view.isReauthenticated,
    () =>
      html`<p class="card-note">
        To disconnect an agent, first
        <a href="${unlockPath(AGENTS_PATH)}">confirm your password</a>.
      </p>`,
  )}
  ${when(
    clients.length > 0,
    () => html`<div class="cards">${clients.map((client) => card(client, view, targets))}</div>`,
  )}`;
}
