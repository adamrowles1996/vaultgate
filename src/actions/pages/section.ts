/**
 * The account page's Actions section (ACT-5): every target with its
 * connector, destination summary (host and base path only, never a
 * credential field or a pattern), state, grants, last call and open
 * sessions, a link to the page that manages it, and a link to create one per
 * connector this build can edit. Present only when the layer is enabled: the
 * composition layer injects this renderer into identity then and never
 * otherwise.
 */
import { cell, type Html, html, tableHead, when } from '../../identity/pages/template.ts';

import { targetPath, UNEXPECTED_PATH } from './paths.ts';

import type { ConnectorKind } from '../../config/actions.ts';

export interface LastCall {
  readonly at: string;
  readonly outcome: string;
}

export interface TargetListItem {
  readonly id: string;
  readonly name: string;
  readonly connector: ConnectorKind;
  readonly destinationSummary: string | undefined;
  readonly enabled: boolean;
  readonly state: 'valid' | 'invalid';
  readonly problems: readonly string[];
  readonly grantNames: readonly string[];
  readonly lastCall: LastCall | undefined;
  readonly openSessions: number;
}

export interface SectionView {
  readonly targets: readonly TargetListItem[];
  readonly connectors: readonly ConnectorKind[];
}

const COLUMNS = [
  'Target',
  'Connector',
  'Destination',
  'Enabled',
  'Grants',
  'Last call',
  'Sessions',
] as const;

/**
ACT-1: a stored row that fails its schema is marked with the reasons; it refuses every call.
*/
function invalidMarker(target: TargetListItem): Html {
  return when(
    target.state === 'invalid',
    () => html`<br /><code>target_invalid</code>: ${target.problems.join('; ')}`,
  );
}

function row(target: TargetListItem): Html {
  const name = html`<a href="${targetPath(target.id)}">${target.name}</a>${invalidMarker(target)}`;
  const lastCall =
    target.lastCall === undefined ? 'never' : `${target.lastCall.at} (${target.lastCall.outcome})`;
  return html`<tr>
    ${cell(COLUMNS[0], name)} ${cell(COLUMNS[1], target.connector)}
    ${cell(COLUMNS[2], target.destinationSummary ?? '')}
    ${cell(COLUMNS[3], target.enabled ? 'yes' : 'no')}
    ${cell(COLUMNS[4], target.grantNames.length === 0 ? 'none' : target.grantNames.join(', '))}
    ${cell(COLUMNS[5], lastCall)} ${cell(COLUMNS[6], String(target.openSessions))}
  </tr>`;
}

export function renderActionsSection(view: SectionView): Html {
  const links = view.connectors.map(
    (kind) =>
      html`<li>
        <a href="/account/actions/new?connector=${kind}">Create an ${kind} target</a>
      </li>`,
  );
  return html`<section id="actions">
    <h3>Actions</h3>
    <p>
      Targets an agent may act on with a credential it never sees. Every change needs a fresh
      password confirmation under Sensitive actions.
    </p>
    ${when(view.targets.length === 0, () => html`<p>No targets are defined.</p>`)}
    ${when(
      view.targets.length > 0,
      () =>
        html`<table>
          ${tableHead(COLUMNS)}
          <tbody>
            ${view.targets.map((target) => row(target))}
          </tbody>
        </table>`,
    )}
    <ul>
      ${links}
    </ul>
    <p>
      <a href="${UNEXPECTED_PATH}">Unexpected writes</a>: every call that changed something without
      a human confirmation, across every target.
    </p>
  </section>`;
}
