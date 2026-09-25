/**
 * The Index card of a Semble connection's page (ACT-115, ACT-108): what the
 * code connector holds for it, read from `engine.code.status` — each
 * snapshot's commit and the ref it was built for, when it was built and
 * whether calls answer from it, its indexes with their file and chunk counts
 * and its skip counts; whether a build is running; the last resolution of
 * the configured ref; the last build and the last failure, by reason code
 * and trigger. **Rebuild index** posts behind the operator's session and
 * synchroniser token (ID-18), not ID-15's window: it deletes every snapshot
 * and builds the configured ref again, and changes no setting.
 */
import { icon } from '../../identity/pages/icons.ts';
import { cell, EMPTY, hidden, type Html, html, tableHead } from '../../identity/pages/template.ts';
import { cardHead, pill, relativeTime, tag } from '../../identity/pages/ui.ts';

import { targetPath } from './paths.ts';

import type { CodeControl, CodeIndexStatus, SnapshotStatus } from '../connectors/code/control.ts';
import type { BuildRecord, Resolution } from '../connectors/code/state.ts';

/**
What the page knows of a code target's index: the connector is off, or its status.
*/
export type IndexView =
  { readonly state: 'off' } | { readonly state: 'status'; readonly status: CodeIndexStatus };

export interface IndexCardView {
  readonly targetId: string;
  readonly csrfToken: string;
  readonly now: number;
  readonly index: IndexView;
}

const COLUMNS = ['Commit', 'Ref', 'Built', 'Calls', 'Indexes', 'Skipped'] as const;
const SHORT_COMMIT = 12;

export function rebuildPath(targetId: string): string {
  return `${targetPath(targetId)}/rebuild`;
}

/**
ACT-115: the index status of a code target, or that the connector is not loaded here.
*/
export async function indexView(
  code: CodeControl | undefined,
  targetId: string,
): Promise<IndexView> {
  return code === undefined
    ? { state: 'off' }
    : { state: 'status', status: await code.status(targetId) };
}

function commit(sha: string): Html {
  return html`<span class="mono" title="${sha}">${sha.slice(0, SHORT_COMMIT)}</span>`;
}

function resolutionLine(resolution: Resolution | undefined, now: number): Html {
  if (resolution === undefined) {
    return html`Not resolved since vaultgate started`;
  }
  const when = relativeTime(resolution.at, now);
  return resolution.failure === undefined
    ? html`<span class="mono">${resolution.ref ?? ''}</span> at ${commit(resolution.commit ?? '')} ·
        ${when}`
    : html`<span class="bad">${resolution.failure}</span> · ${when}`;
}

function buildLine(build: BuildRecord | undefined, now: number): Html {
  if (build === undefined) {
    return html`None since vaultgate started`;
  }
  const outcome =
    build.reason === undefined
      ? pill('ok', 'Built')
      : html`${pill('bad', 'Failed')} <span class="mono">${build.reason}</span>`;
  const built = html`${commit(build.commit)} (<span class="mono">${build.ref}</span>)`;
  const when = `on ${build.trigger} · ${relativeTime(build.at, now)}`;
  return html`${outcome} · ${built} · ${when}`;
}

function variants(snapshot: SnapshotStatus): Html {
  const entries = Object.entries(snapshot.variants).map(
    ([content, meta]) =>
      html`<span class="cell-main"
        ><span class="mono">${content}</span
        ><span class="cell-sub">${meta.files} files · ${meta.chunks} chunks</span></span
      >`,
  );
  return entries.length === 0 ? html`<span class="cell-sub">None yet</span>` : html`${entries}`;
}

function skipped(snapshot: SnapshotStatus): Html {
  const { excluded, large, links, special } = snapshot.skipped;
  return html`<span class="cell-sub"
    >${excluded} excluded · ${large} too large · ${links} links · ${special} special</span
  >`;
}

function snapshotRow(snapshot: SnapshotStatus, now: number): Html {
  return html`<tr>
    ${cell(COLUMNS[0], commit(snapshot.commit))}
    ${cell(COLUMNS[1], html`<span class="mono">${snapshot.ref ?? 'not known since a restart'}</span>`)}
    ${cell(COLUMNS[2], relativeTime(snapshot.created_at, now))}
    ${cell(COLUMNS[3], snapshot.current ? tag('Answers calls', 'green') : 'Not the current one')}
    ${cell(COLUMNS[4], variants(snapshot))} ${cell(COLUMNS[5], skipped(snapshot))}
  </tr>`;
}

function snapshotTable(status: CodeIndexStatus, now: number): Html {
  if (status.snapshots.length === 0) {
    return html`<p class="card-note">No snapshot yet: the next build or call makes one.</p>`;
  }
  return html`<table class="snapshots">
    ${tableHead(COLUMNS)}
    <tbody>
      ${status.snapshots.map((snapshot) => snapshotRow(snapshot, now))}
    </tbody>
  </table>`;
}

function statusBody(status: CodeIndexStatus, now: number): Html {
  const failure = status.lastFailure;
  const reachability = status.reachable
    ? EMPTY
    : html`<p class="error" role="alert">
        The code sidecar is not answering: calls answer index_unavailable until it does, and the
        snapshots it holds cannot be listed.
      </p>`;
  return html`${reachability}
    <dl class="kv">
      <dt>Building</dt>
      <dd>${status.building ? tag('A build is running', 'amber', 'clock') : 'No'}</dd>
      <dt>Configured ref</dt>
      <dd>${resolutionLine(status.resolution, now)}</dd>
      <dt>Last build</dt>
      <dd>${buildLine(status.lastBuild, now)}</dd>
      <dt>Last failure</dt>
      <dd>${failure === undefined ? 'None since vaultgate started' : buildLine(failure, now)}</dd>
    </dl>
    ${snapshotTable(status, now)}`;
}

function rebuildButton(view: IndexCardView): Html {
  return html`<form method="post" action="${rebuildPath(view.targetId)}">
    ${hidden('csrf', view.csrfToken)}
    <button type="submit">${icon('refresh')}Rebuild index</button>
  </form>`;
}

export function indexCard(view: IndexCardView): Html {
  const { index, now } = view;
  if (index.state === 'off') {
    return html`<section class="card" id="index">
      ${cardHead('Index')}
      <p class="card-note">
        The code connector is off on this deployment (VAULTGATE_ACTIONS_ENABLE_CODE), so this
        connection has no index and agents cannot search it.
      </p>
    </section>`;
  }
  return html`<section class="card" id="index">
    ${cardHead(
      'Index',
      'The snapshots of the repository and the semble indexes calls search. Rebuilding deletes every snapshot and builds the configured ref again.',
      rebuildButton(view),
    )}
    ${statusBody(index.status, now)}
  </section>`;
}
