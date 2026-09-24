/**
 * One target's page (ACT-5, ACT-63 basic): its status with the vault item's
 * name and any validation problem (ACT-1), the sessions and calls it has
 * seen, and, inside the re-authentication window (ID-15), the forms that
 * edit, enable, disable and delete it, manage its grants (ACT-9) and close
 * its sessions. Every form posts to `/account/actions/...` (ID-18).
 */
import {
  cell,
  document,
  errorBanner,
  hidden,
  type Html,
  html,
  noticeBanner,
  tableHead,
  when,
} from '../../identity/pages/template.ts';

import { type CallItem, renderCallTable } from './calls.ts';
import { callsPath, targetPath } from './paths.ts';
import { renderProblems, renderTargetForm } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormValues } from './form-values.ts';
import type { FieldProblems } from './messages.ts';
import type { TargetSummary } from '../targets.ts';

export interface GrantItem {
  readonly clientId: string;
  readonly clientName: string;
  readonly grantedAt: string;
}

/**
A client holding a consent (ACT-9), as the OAuth layer lists it through the injected lister.
*/
export interface ClientChoice {
  readonly clientId: string;
  readonly clientName: string | undefined;
}

export interface TargetPageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  /**
  ACT-88: the target's policy allows any command; the page says so on every visit.
  */
  readonly isUnrestricted: boolean;
  /**
  ACT-49: the policy allows a non-read operation and asks no human to confirm one.
  */
  readonly isUnconfirmed: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly fieldProblems: FieldProblems;
  readonly target: TargetSummary;
  /**
  The vault item's name (ACT-4), or why it could not be read.
  */
  readonly itemName: string;
  readonly openSessions: number;
  readonly grants: readonly GrantItem[];
  readonly candidates: readonly ClientChoice[];
  readonly calls: readonly CallItem[];
  /**
  Absent when this build cannot edit the connector's documents (a later milestone's connector).
  */
  readonly form: ConnectorForm | undefined;
  readonly values: FormValues;
}

const STATUS_COLUMNS = ['Setting', 'Value'] as const;
const GRANT_COLUMNS = ['Client', 'Granted', ''] as const;

const REAUTHENTICATION_ANCHOR = '/account#sensitive-actions';

/**
ACT-88: the standing warning an any-command target carries, shown whether or not it is being edited.
*/
const UNRESTRICTED_WARNING =
  'This target allows any command: a granted client can run anything its login can, and every ' +
  'call is audited with the full command.';

/**
ACT-49: the note a target carries once the operator turns the confirmation off.
*/
const UNCONFIRMED_NOTE =
  'Confirmation is off: a granted client can change things here without asking anyone. New ' +
  'targets ask for a confirmation on every non-read call; this one relies on the grant and on ' +
  'the prompt the client may show. Review the unexpected writes below.';

function statusRow(label: string, value: string | Html): Html {
  return html`<tr>
    ${cell(STATUS_COLUMNS[0], label)} ${cell(STATUS_COLUMNS[1], value)}
  </tr>`;
}

function statusTable(view: TargetPageView): Html {
  const { target } = view;
  const state =
    target.state === 'valid'
      ? html`valid`
      : html`<code>target_invalid</code>: ${target.problems.join('; ')}`;
  const rows = [
    statusRow('Connector', target.connector),
    statusRow('Destination', target.destinationSummary ?? 'not readable'),
    statusRow('Enabled', target.enabled ? 'yes' : 'no'),
    statusRow('State', state),
    statusRow('Vault item', `${target.credential.item_id} (${view.itemName})`),
    statusRow('Revision', String(target.revision)),
    statusRow('Updated', new Date(target.updatedAt).toISOString()),
    statusRow('Open sessions', String(view.openSessions)),
  ];
  return html`<table>
    ${tableHead(STATUS_COLUMNS)}
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function actionForm(action: string, csrfToken: string, label: string, body: Html = html``): Html {
  return html`<form method="post" action="${action}">
    ${hidden('csrf', csrfToken)} ${body}
    <button type="submit">${label}</button>
  </form>`;
}

function lifecycleForms(view: TargetPageView): Html {
  const base = targetPath(view.target.id);
  const toggle = view.target.enabled
    ? actionForm(`${base}/disable`, view.csrfToken, 'Disable target')
    : actionForm(`${base}/enable`, view.csrfToken, 'Enable target');
  return html`${toggle} ${actionForm(`${base}/sessions/close`, view.csrfToken, 'Close sessions')}
  ${actionForm(`${base}/delete`, view.csrfToken, 'Delete target')}`;
}

function grantsSection(view: TargetPageView): Html {
  const base = targetPath(view.target.id);
  const rows = view.grants.map(
    (grant) =>
      html`<tr>
        ${cell(GRANT_COLUMNS[0], grant.clientName)} ${cell(GRANT_COLUMNS[1], grant.grantedAt)}
        ${cell(
          GRANT_COLUMNS[2],
          when(view.isReauthenticated, () =>
            actionForm(
              `${base}/grants/revoke`,
              view.csrfToken,
              'Remove',
              hidden('client_id', grant.clientId),
            ),
          ),
        )}
      </tr>`,
  );
  const options = view.candidates.map(
    (client) =>
      html`<option value="${client.clientId}">${client.clientName ?? client.clientId}</option>`,
  );
  const add = html`<label
    >Client
    <select name="client_id">
      ${options}
    </select>
  </label>`;
  return html`<section>
    <h3>Grants</h3>
    ${when(view.grants.length === 0, () => html`<p>No client is granted this target.</p>`)}
    ${when(
      view.grants.length > 0,
      () =>
        html`<table>
          ${tableHead(GRANT_COLUMNS)}
          <tbody>
            ${rows}
          </tbody>
        </table>`,
    )}
    ${when(
      view.isReauthenticated && view.candidates.length > 0,
      () => html`${actionForm(`${base}/grants`, view.csrfToken, 'Grant', add)}`,
    )}
    ${when(
      view.isReauthenticated && view.candidates.length === 0,
      () => html`<p>Every connected client already holds a grant, or none is connected.</p>`,
    )}
  </section>`;
}

/**
ACT-63: the last 50 calls here; the history page pages back through the rest.
*/
function callsSection(view: TargetPageView): Html {
  return html`<section>
    <h3>Recent calls</h3>
    ${renderCallTable(view.calls)}
    <p><a href="${callsPath(view.target.id)}">The whole call history</a></p>
  </section>`;
}

function editSection(view: TargetPageView): Html {
  return html`<section>
    <h3>Edit</h3>
    ${renderProblems(view.fieldProblems)}
    ${when(
      view.form === undefined,
      () => html`<p>This build cannot edit ${view.target.connector} targets yet.</p>`,
    )}
    ${
      view.form === undefined
        ? html``
        : renderTargetForm({
            action: targetPath(view.target.id),
            csrfToken: view.csrfToken,
            form: view.form,
            values: view.values,
            problems: view.fieldProblems,
            isNew: false,
            submitLabel: 'Save target',
          })
    }
    ${lifecycleForms(view)}
  </section>`;
}

export function renderTargetPage(view: TargetPageView): string {
  return document(
    `Target ${view.target.name}`,
    html`<h2>Target <code>${view.target.name}</code></h2>
      ${errorBanner(view.error)}
      ${when(view.isUnrestricted, () => errorBanner(UNRESTRICTED_WARNING))}
      ${when(view.isUnconfirmed, () => errorBanner(UNCONFIRMED_NOTE))} ${noticeBanner(view.notice)}
      <p><a href="/account#actions">Back to the account page</a></p>
      <p>${view.target.description}</p>
      ${statusTable(view)}
      ${when(
        !view.isReauthenticated,
        () =>
          html`<p>
            To change this target, first
            <a href="${REAUTHENTICATION_ANCHOR}">confirm your password</a> under Sensitive actions.
          </p>`,
      )}
      ${when(view.isReauthenticated, () => editSection(view))} ${grantsSection(view)}
      ${callsSection(view)}`,
  );
}
