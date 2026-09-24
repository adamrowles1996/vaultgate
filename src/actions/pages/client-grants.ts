/**
 * Grants seen from the client's side (ACT-9): the cell the account page's
 * connected-clients list shows for each client — the targets it may act on,
 * a Remove form per grant and a picker for the rest — so an operator can
 * grant from either end. The OAuth layer renders the list and never imports
 * this module (ACT-70); the composition layer hands it this renderer, whose
 * shape is `ClientTargetsRenderer` in `src/oauth/connected-clients.ts`.
 */
import { hidden, type Html, html, when } from '../../identity/pages/template.ts';

import { clientGrantRevokePath, clientGrantsPath } from './paths.ts';
import { TARGET_FIELD } from './target-writes.ts';

import type { ActionsPagesDependencies } from './view.ts';
import type { TargetSummary } from '../targets.ts';

/**
What the list knows about the operator's session; the same shape the OAuth renderer takes.
*/
export interface GrantFormContext {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
}

export type ClientTargets = (clientId: string, view: GrantFormContext) => Html;

function isGrantedTo(target: TargetSummary, clientId: string): boolean {
  return target.grants.some(
    (grant) => grant.clientId === clientId && grant.revokedAt === undefined,
  );
}

function grantForm(action: string, view: GrantFormContext, label: string, body: Html): Html {
  return html`<form method="post" action="${action}">
    ${hidden('csrf', view.csrfToken)} ${body}
    <button type="submit">${label}</button>
  </form>`;
}

function grantedItem(target: TargetSummary, clientId: string, view: GrantFormContext): Html {
  const revoke = grantForm(
    clientGrantRevokePath(clientId),
    view,
    'Remove',
    hidden(TARGET_FIELD, target.id),
  );
  return html`<li>
    <code>${target.name}</code> (${target.connector}) ${when(view.isReauthenticated, () => revoke)}
  </li>`;
}

function picker(
  candidates: readonly TargetSummary[],
  clientId: string,
  view: GrantFormContext,
): Html {
  const options = candidates.map(
    (target) => html`<option value="${target.id}">${target.name}</option>`,
  );
  const select = html`<label
    >Target
    <select name="${TARGET_FIELD}">
      ${options}
    </select>
  </label>`;
  return grantForm(clientGrantsPath(clientId), view, 'Grant', select);
}

/**
 * The renderer the composition layer injects into the connected-clients
 * list. It reads the targets service only, so a client with no grant and a
 * deployment with no target both render as one sentence.
 */
export function createClientTargets(
  dependencies: Pick<ActionsPagesDependencies, 'targets'>,
): ClientTargets {
  return (clientId, view) => {
    const targets = dependencies.targets.list();
    const granted = targets.filter((target) => isGrantedTo(target, clientId));
    const candidates = targets.filter((target) => !isGrantedTo(target, clientId));
    return html`${when(granted.length === 0, () => html`<p>No target.</p>`)}
    ${when(
      granted.length > 0,
      () =>
        html`<ul>
          ${granted.map((target) => grantedItem(target, clientId, view))}
        </ul>`,
    )}
    ${when(view.isReauthenticated && candidates.length > 0, () =>
      picker(candidates, clientId, view),
    )}`;
  };
}
