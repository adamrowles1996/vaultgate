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

import { targetPath } from './section.ts';
import { renderProblems, renderTargetForm } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormValues } from './form-values.ts';
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

export interface CallItem {
  readonly at: string;
  readonly tool: string;
  readonly operation: string;
  readonly classification: string;
  readonly outcome: string;
  readonly elicitation: string;
  readonly outputBytes: number;
  readonly clientId: string;
}

export interface TargetPageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly problems: readonly string[];
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
const CALL_COLUMNS = [
  'Time',
  'Tool',
  'Operation',
  'Classification',
  'Outcome',
  'Elicitation',
  'Output bytes',
  'Client',
] as const;

const REAUTHENTICATION_ANCHOR = '/account#sensitive-actions';

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

function callsSection(view: TargetPageView): Html {
  const rows = view.calls.map(
    (call) =>
      html`<tr>
        ${cell(CALL_COLUMNS[0], call.at)} ${cell(CALL_COLUMNS[1], call.tool)}
        ${cell(CALL_COLUMNS[2], call.operation)} ${cell(CALL_COLUMNS[3], call.classification)}
        ${cell(CALL_COLUMNS[4], call.outcome)} ${cell(CALL_COLUMNS[5], call.elicitation)}
        ${cell(CALL_COLUMNS[6], String(call.outputBytes))} ${cell(CALL_COLUMNS[7], call.clientId)}
      </tr>`,
  );
  return html`<section>
    <h3>Recent calls</h3>
    ${when(view.calls.length === 0, () => html`<p>No calls yet.</p>`)}
    ${when(
      view.calls.length > 0,
      () =>
        html`<table>
          ${tableHead(CALL_COLUMNS)}
          <tbody>
            ${rows}
          </tbody>
        </table>`,
    )}
  </section>`;
}

function editSection(view: TargetPageView): Html {
  return html`<section>
    <h3>Edit</h3>
    ${renderProblems(view.problems)}
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
      ${errorBanner(view.error)} ${noticeBanner(view.notice)}
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
