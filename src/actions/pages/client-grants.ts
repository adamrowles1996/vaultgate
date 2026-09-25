/**
 * Grants seen from the agent's side (ACT-9): the row each agent's card on
 * the Agents page shows — the computers it may act on, each a link to the
 * computer — while the matrix below the cards grants and removes them. The
 * OAuth layer renders the cards and never imports this module (ACT-70); the
 * composition layer hands it this renderer, whose shape is
 * `ClientTargetsRenderer` in `src/oauth/connected-clients.ts`.
 */
import { type Html, html } from '../../identity/pages/template.ts';

import { targetPath } from './paths.ts';

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

/**
 * The renderer the composition layer injects into the Agents page's cards.
 * It reads the targets service only, so an agent with no grant and a
 * deployment with no computer both render as one sentence.
 */
export function createClientTargets(
  dependencies: Pick<ActionsPagesDependencies, 'targets'>,
): ClientTargets {
  return (clientId) => {
    const granted = dependencies.targets.list().filter((target) => isGrantedTo(target, clientId));
    if (granted.length === 0) {
      return html`<p class="card-note">No connection yet.</p>`;
    }
    return html`<p class="chips" aria-label="Connections">
      ${granted.map(
        (target) => html`<a class="tag mono" href="${targetPath(target.id)}">${target.name}</a>`,
      )}
    </p>`;
  };
}
