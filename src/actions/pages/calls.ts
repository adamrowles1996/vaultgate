/**
 * The call trail as the operator reads it (ACT-63): the table a computer's
 * page and its history page share, the history page itself with its "older
 * calls" link, the unexpected-write view — every non-read call across
 * targets that no human accepted, which is what makes a target with
 * `confirm_writes: false` reviewable — and the recent calls the Activity page
 * shows. Results are never stored; the arguments are, scrubbed (ACT-61), so
 * the excerpt here is the only record of what ran.
 */
import { cell, EMPTY, type Html, html, tableHead, when } from '../../identity/pages/template.ts';
import { cardHead, pageHead, tag, type TagTone } from '../../identity/pages/ui.ts';

import { callsPath, CREATE_PATH, targetPath, UNEXPECTED_PATH } from './paths.ts';

import type { ConsolePage } from '../../identity/index.ts';

/**
One `action_calls` row as a page shows it; `arguments` is already scrubbed and capped (ACT-61).
*/
export interface CallItem {
  readonly at: string;
  readonly targetId: string | undefined;
  readonly targetName: string;
  readonly tool: string;
  readonly operation: string;
  readonly classification: string;
  readonly outcome: string;
  readonly elicitation: string;
  readonly outputBytes: number;
  readonly clientId: string;
  /**
  The agent's name while it is connected, its client id afterwards.
  */
  readonly clientName: string;
  readonly argumentsExcerpt: string;
}

/**
Where the next, older page starts; absent on the last page.
*/
export interface CallCursor {
  readonly at: number;
  readonly id: string;
}

export interface CallHistoryView {
  readonly targetId: string;
  readonly targetName: string;
  readonly calls: readonly CallItem[];
  readonly older: CallCursor | undefined;
}

export interface UnexpectedView {
  readonly calls: readonly CallItem[];
  readonly older: CallCursor | undefined;
}

const CALL_COLUMNS = [
  'Time',
  'Agent',
  'Tool',
  'Operation',
  'Classification',
  'Outcome',
  'Confirmation',
  'Output bytes',
] as const;

const TRAIL_COLUMNS = [
  'Time',
  'Connection',
  'Agent',
  'Tool',
  'Classification',
  'Outcome',
  'Confirmation',
  'Arguments',
] as const;

/**
The cursor a link carries: the `(at, id)` the previous page ended at, as one opaque parameter.
*/
export function cursorParameter(cursor: CallCursor): string {
  return `${String(cursor.at)}.${cursor.id}`;
}

export function parseCursor(text: string | undefined): CallCursor | undefined {
  if (text === undefined) {
    return undefined;
  }
  const dot = text.indexOf('.');
  const at = Number(text.slice(0, dot));
  const id = text.slice(dot + 1);
  return dot === -1 || !Number.isSafeInteger(at) || id.length === 0 ? undefined : { at, id };
}

function olderLink(path: string, older: CallCursor | undefined): Html {
  return older === undefined
    ? html`<p class="card-note trail-end">This is the whole trail kept for these calls.</p>`
    : html`<p class="trail-end">
        <a class="button small" href="${path}?before=${cursorParameter(older)}">Older calls</a>
      </p>`;
}

function outcomeTone(outcome: string): TagTone {
  if (outcome === 'ok') {
    return 'green';
  }
  return outcome.startsWith('denied:') ? 'amber' : 'red';
}

/**
ACT-60: `ok`, or the refusal or failure code, coloured by which of the three it is.
*/
export function outcomeTag(outcome: string): Html {
  return tag(outcome, outcomeTone(outcome));
}

/**
ACT-47: whether a person was asked, and what they answered.
*/
export function confirmationText(elicitation: string): Html {
  if (elicitation === 'not_required') {
    return html`<span class="cell-sub">Not needed</span>`;
  }
  return elicitation === 'accepted' ? tag('accepted', 'green', 'check') : tag(elicitation, 'amber');
}

function callRow(call: CallItem): Html {
  return html`<tr>
    ${cell(CALL_COLUMNS[0], call.at)} ${cell(CALL_COLUMNS[1], call.clientName)}
    ${cell(CALL_COLUMNS[2], html`<span class="mono">${call.tool}</span>`)}
    ${cell(CALL_COLUMNS[3], call.operation)} ${cell(CALL_COLUMNS[4], call.classification)}
    ${cell(CALL_COLUMNS[5], outcomeTag(call.outcome))}
    ${cell(CALL_COLUMNS[6], confirmationText(call.elicitation))}
    ${cell(CALL_COLUMNS[7], String(call.outputBytes))}
  </tr>`;
}

/**
The calls of one target, newest first; the same table on the computer's page and on its history page.
*/
export function renderCallTable(calls: readonly CallItem[]): Html {
  return html`${when(calls.length === 0, () => html`<p class="empty">No calls yet.</p>`)}
  ${when(
    calls.length > 0,
    () =>
      html`<table>
        ${tableHead(CALL_COLUMNS)}
        <tbody>
          ${calls.map((call) => callRow(call))}
        </tbody>
      </table>`,
  )}`;
}

export function callHistoryPage(view: CallHistoryView): ConsolePage {
  return {
    title: `Calls of ${view.targetName}`,
    active: 'computers',
    crumbs: [
      { label: 'Connections', href: CREATE_PATH },
      {
        label: html`<span class="mono">${view.targetName}</span>`,
        href: targetPath(view.targetId),
      },
      { label: 'Calls' },
    ],
    body: html`${pageHead(
        `Calls of ${view.targetName}`,
        'Newest first, 50 at a time. Results are never stored; the arguments are, scrubbed of every injected value.',
      )}
      <section class="card flush">
        ${renderCallTable(view.calls)} ${olderLink(callsPath(view.targetId), view.older)}
      </section>`,
    returnTo: callsPath(view.targetId),
  };
}

function trailRow(call: CallItem): Html {
  const computer =
    call.targetId === undefined
      ? html`<span class="mono">${call.targetName}</span>`
      : html`<a class="mono" href="${targetPath(call.targetId)}">${call.targetName}</a>`;
  return html`<tr>
    ${cell(TRAIL_COLUMNS[0], call.at)} ${cell(TRAIL_COLUMNS[1], computer)}
    ${cell(TRAIL_COLUMNS[2], call.clientName)}
    ${cell(TRAIL_COLUMNS[3], html`<span class="mono">${call.tool}</span>`)}
    ${cell(TRAIL_COLUMNS[4], call.classification)}
    ${cell(TRAIL_COLUMNS[5], outcomeTag(call.outcome))}
    ${cell(TRAIL_COLUMNS[6], confirmationText(call.elicitation))}
    ${cell(TRAIL_COLUMNS[7], html`<code>${call.argumentsExcerpt}</code>`)}
  </tr>`;
}

/**
Calls across computers, newest first: the unexpected writes, or everything recent on Activity.
*/
export function renderTrailTable(calls: readonly CallItem[], empty: string): Html {
  if (calls.length === 0) {
    return html`<p class="empty">${empty}</p>`;
  }
  return html`<table>
    ${tableHead(TRAIL_COLUMNS)}
    <tbody>
      ${calls.map((call) => trailRow(call))}
    </tbody>
  </table>`;
}

/**
ACT-63: every non-read call, across targets, that no human accepted through a confirmation.
*/
export function unexpectedPage(view: UnexpectedView): ConsolePage {
  return {
    title: 'Unexpected writes',
    active: 'activity',
    crumbs: [{ label: 'Activity', href: '/account/activity' }, { label: 'Unexpected writes' }],
    body: html`${pageHead(
        'Unexpected writes',
        'Every call that changed something — a write, a shell command or a browser action — and was not accepted by a human through a confirmation, newest first, across every connection. A connection that asks for confirmation on every non-read call appears here only when one was declined, cancelled, expired or refused.',
      )}
      <section class="card flush">
        ${renderTrailTable(view.calls, 'No unexpected write has been recorded.')}
        ${olderLink(UNEXPECTED_PATH, view.older)}
      </section>`,
    returnTo: UNEXPECTED_PATH,
  };
}

/**
The Activity page's section (ACT-63): the latest calls across computers and the way to the unexpected writes.
*/
export function activitySection(calls: readonly CallItem[], unexpectedCount: number): Html {
  const badge =
    unexpectedCount > 0 ? tag(`${String(unexpectedCount)} this week`, 'amber', 'alert') : EMPTY;
  return html`<section class="card flush" id="recent-calls">
    ${cardHead(
      'Recent calls',
      'The latest calls agents made through your connections.',
      html`<a class="button small" href="${UNEXPECTED_PATH}">Unexpected writes ${badge}</a>`,
    )}
    ${renderTrailTable(calls, 'No agent has made a call yet.')}
  </section>`;
}
