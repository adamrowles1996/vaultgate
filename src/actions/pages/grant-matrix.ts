/**
 * The Agents page's view of grants (ACT-9): one row per computer, one column
 * per connected agent, a filled square where the agent is granted the
 * computer. Inside the re-authentication window (ID-15) every square is a
 * button that grants or removes that one grant through the client grant
 * routes, the same checks and the same ACT-7 event as a computer's own page,
 * and comes back here. A grant never widens a token (ACT-11).
 */
import { icon } from '../../identity/pages/icons.ts';
import { cell, hidden, type Html, html } from '../../identity/pages/template.ts';
import { cardHead, monogram } from '../../identity/pages/ui.ts';

import { KINDS } from './kinds.ts';
import { clientGrantRevokePath, clientGrantsPath, targetPath } from './paths.ts';
import { RETURN_FIELD, RETURN_TO_AGENTS } from './return-to.ts';
import { TARGET_FIELD } from './target-writes.ts';

import type { ComputerKind } from './kinds.ts';
import type { ClientChoice } from './target-grants.ts';

export interface MatrixComputer {
  readonly id: string;
  readonly name: string;
  readonly kind: ComputerKind;
  /**
  The client ids holding a live grant on this computer.
  */
  readonly granted: ReadonlySet<string>;
}

export interface MatrixView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly computers: readonly MatrixComputer[];
  readonly clients: readonly ClientChoice[];
}

function nameOf(client: ClientChoice): string {
  return client.clientName ?? client.clientId;
}

function square(isGranted: boolean): Html {
  return html`<span class="square${isGranted ? ' is-granted' : ''}" aria-hidden="true"
    >${isGranted ? icon('check') : html``}</span
  >`;
}

function toggle(computer: MatrixComputer, client: ClientChoice, view: MatrixView): Html {
  const isGranted = computer.granted.has(client.clientId);
  const label = `${isGranted ? 'Remove' : 'Grant'} ${computer.name} ${isGranted ? 'from' : 'to'} ${nameOf(client)}`;
  if (!view.isReauthenticated) {
    return html`${square(isGranted)}<span class="visually-hidden"
        >${isGranted ? 'Granted' : 'Not granted'}</span
      >`;
  }
  const action = isGranted
    ? clientGrantRevokePath(client.clientId)
    : clientGrantsPath(client.clientId);
  return html`<form method="post" action="${action}">
    ${hidden('csrf', view.csrfToken)} ${hidden(TARGET_FIELD, computer.id)}
    ${hidden(RETURN_FIELD, RETURN_TO_AGENTS)}
    <button type="submit" class="square-button" aria-label="${label}" title="${label}">
      ${square(isGranted)}
    </button>
  </form>`;
}

function row(computer: MatrixComputer, view: MatrixView): Html {
  const kind = KINDS[computer.kind];
  const name = html`<span class="cell-with-tile"
    ><span class="kind-tile small kind-${computer.kind}" title="${kind.label}"
      >${icon(kind.icon)}</span
    ><a class="mono" href="${targetPath(computer.id)}">${computer.name}</a></span
  >`;
  return html`<tr>
    ${cell('Computer', name)}
    ${view.clients.map((client) => cell(nameOf(client), toggle(computer, client, view)))}
  </tr>`;
}

function header(clients: readonly ClientChoice[]): Html {
  const headings = clients.map(
    (client) =>
      html`<th scope="col">
        <span class="cell-with-tile"
          >${monogram(client.clientId, nameOf(client))}${nameOf(client)}</span
        >
      </th>`,
  );
  return html`<thead>
    <tr>
      <th scope="col">Computer</th>
      ${headings}
    </tr>
  </thead>`;
}

/**
ACT-9: who may use what, across every computer and every connected agent.
*/
export function grantMatrix(view: MatrixView): Html {
  const note = view.isReauthenticated
    ? 'Press a square to grant or remove. Removing a grant also closes that agent’s sessions on the computer.'
    : 'Confirm your password to change a grant here.';
  const table =
    view.computers.length === 0 || view.clients.length === 0
      ? html`<p class="empty">
          Grants appear here once there is a computer and a connected agent.
        </p>`
      : html`<table class="matrix">
          ${header(view.clients)}
          <tbody>
            ${view.computers.map((computer) => row(computer, view))}
          </tbody>
        </table>`;
  return html`<section class="card flush" id="access">
    ${cardHead('Who can use what', note)} ${table}
  </section>`;
}
