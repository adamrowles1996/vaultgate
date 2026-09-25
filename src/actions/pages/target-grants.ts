/**
 * The two cards of a computer's page that change things (ACT-5, ACT-8,
 * ACT-9): the agents granted it, with Remove and a picker among the clients
 * that hold a consent, and the management card that closes its sessions and
 * deletes it. Inside the re-authentication window (ID-15) they carry their
 * forms; outside it they say how to get there. Every form posts to
 * `/account/actions/<id>/...` (ID-18).
 */
import { unlockPath } from '../../identity/pages/console.ts';
import { icon } from '../../identity/pages/icons.ts';
import { EMPTY, hidden, type Html, html, when } from '../../identity/pages/template.ts';
import { cardHead, formatInstant, monogram } from '../../identity/pages/ui.ts';

import { targetPath } from './paths.ts';

export interface GrantItem {
  readonly clientId: string;
  readonly clientName: string;
  readonly grantedAt: number;
}

/**
A client holding a consent (ACT-9), as the OAuth layer lists it through the injected lister.
*/
export interface ClientChoice {
  readonly clientId: string;
  readonly clientName: string | undefined;
}

interface CardContext {
  readonly targetId: string;
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
}

export interface GrantsCardView extends CardContext {
  readonly grants: readonly GrantItem[];
  readonly candidates: readonly ClientChoice[];
}

function form(action: string, view: CardContext, button: Html, body: Html = EMPTY): Html {
  return html`<form method="post" action="${action}">
    ${hidden('csrf', view.csrfToken)} ${body} ${button}
  </form>`;
}

function grantRow(grant: GrantItem, view: GrantsCardView): Html {
  const remove = form(
    `${targetPath(view.targetId)}/grants/revoke`,
    view,
    html`<button type="submit" class="ghost small">Remove</button>`,
    hidden('client_id', grant.clientId),
  );
  return html`<li class="grant">
    ${monogram(grant.clientId, grant.clientName)}
    <span class="cell-main"
      ><span>${grant.clientName}</span
      ><span class="cell-sub">Granted ${formatInstant(grant.grantedAt)}</span></span
    >
    ${when(view.isReauthenticated, () => remove)}
  </li>`;
}

function picker(view: GrantsCardView): Html {
  const options = view.candidates.map(
    (client) =>
      html`<option value="${client.clientId}">${client.clientName ?? client.clientId}</option>`,
  );
  const select = html`<label class="grow"
    >Agent
    <select name="client_id">
      ${options}
    </select>
  </label>`;
  return html`<div class="toolbar">
    ${form(
      `${targetPath(view.targetId)}/grants`,
      view,
      html`<button type="submit">${icon('plus')}Grant</button>`,
      select,
    )}
  </div>`;
}

function grantFooter(view: GrantsCardView): Html {
  if (!view.isReauthenticated) {
    return html`<p class="card-note">
      <a href="${unlockPath(targetPath(view.targetId))}">Confirm your password</a> to grant or
      remove an agent.
    </p>`;
  }
  return view.candidates.length > 0
    ? picker(view)
    : html`<p class="card-note">
        Every connected agent already holds a grant, or none is connected.
      </p>`;
}

/**
ACT-9: the agents granted this computer; a grant never widens an agent's token (ACT-11).
*/
export function grantsCard(view: GrantsCardView): Html {
  return html`<section class="card" id="grants">
    ${cardHead(
      'Agents with access',
      'An agent also needs the scope for this kind of connection, which it asks for when it connects.',
    )}
    ${when(view.grants.length === 0, () => html`<p class="muted">No agent is granted this connection.</p>`)}
    ${when(
      view.grants.length > 0,
      () =>
        html`<ul class="grants">
          ${view.grants.map((grant) => grantRow(grant, view))}
        </ul>`,
    )}
    ${grantFooter(view)}
  </section>`;
}

export interface ManageCardView extends CardContext {
  readonly isEnabled: boolean;
}

/**
ACT-5, ACT-8: close every open session, and delete the computer (its calls stay in the trail).
*/
export function manageCard(view: ManageCardView): Html {
  const base = targetPath(view.targetId);
  return when(
    view.isReauthenticated,
    () =>
      html`<section class="card" id="manage">
        ${cardHead(
          'Manage',
          'Deleting removes the connection, its grants and its sessions; its calls stay in the audit trail.',
        )}
        <div class="button-row">
          ${form(`${base}/sessions/close`, view, html`<button type="submit">Close sessions</button>`)}
          ${form(
            `${base}/delete`,
            view,
            html`<button type="submit" class="danger">${icon('trash')}Delete connection</button>`,
          )}
        </div>
      </section>`,
  );
}
