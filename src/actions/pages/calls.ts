/**
 * The call trail as the operator reads it (ACT-63): the table a target's
 * page and its history page share, the history page itself with its "older
 * calls" link, and the unexpected-write view — every non-read call across
 * targets that no human accepted, which is what makes a target with
 * `confirm_writes: false` reviewable. Results are never stored; the
 * arguments are, scrubbed (ACT-61), so the excerpt here is the only record
 * of what ran.
 */
import { cell, document, type Html, html, tableHead, when } from '../../identity/pages/template.ts';

import { callsPath, targetPath, UNEXPECTED_PATH } from './paths.ts';

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
  'Tool',
  'Operation',
  'Classification',
  'Outcome',
  'Elicitation',
  'Output bytes',
  'Client',
] as const;

const UNEXPECTED_COLUMNS = [
  'Time',
  'Target',
  'Client',
  'Tool',
  'Classification',
  'Outcome',
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
    ? html`<p>This is the whole trail kept for these calls.</p>`
    : html`<p><a href="${path}?before=${cursorParameter(older)}">Older calls</a></p>`;
}

function callRow(call: CallItem): Html {
  return html`<tr>
    ${cell(CALL_COLUMNS[0], call.at)} ${cell(CALL_COLUMNS[1], call.tool)}
    ${cell(CALL_COLUMNS[2], call.operation)} ${cell(CALL_COLUMNS[3], call.classification)}
    ${cell(CALL_COLUMNS[4], call.outcome)} ${cell(CALL_COLUMNS[5], call.elicitation)}
    ${cell(CALL_COLUMNS[6], String(call.outputBytes))} ${cell(CALL_COLUMNS[7], call.clientId)}
  </tr>`;
}

/**
The calls of one target, newest first; the same table on the target's page and on its history page.
*/
export function renderCallTable(calls: readonly CallItem[]): Html {
  return html`${when(calls.length === 0, () => html`<p>No calls yet.</p>`)}
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

export function renderCallHistoryPage(view: CallHistoryView): string {
  return document(
    `Calls of ${view.targetName}`,
    html`<h2>Calls of <code>${view.targetName}</code></h2>
      <p><a href="${targetPath(view.targetId)}">Back to the target</a></p>
      <p>
        Newest first, 50 at a time. Results are never stored; the arguments are, scrubbed of every
        injected value.
      </p>
      ${renderCallTable(view.calls)} ${olderLink(callsPath(view.targetId), view.older)}`,
  );
}

function unexpectedRow(call: CallItem): Html {
  const target =
    call.targetId === undefined
      ? html`${call.targetName}`
      : html`<a href="${targetPath(call.targetId)}">${call.targetName}</a>`;
  return html`<tr>
    ${cell(UNEXPECTED_COLUMNS[0], call.at)} ${cell(UNEXPECTED_COLUMNS[1], target)}
    ${cell(UNEXPECTED_COLUMNS[2], call.clientId)} ${cell(UNEXPECTED_COLUMNS[3], call.tool)}
    ${cell(UNEXPECTED_COLUMNS[4], call.classification)} ${cell(UNEXPECTED_COLUMNS[5], call.outcome)}
    ${cell(UNEXPECTED_COLUMNS[6], html`<code>${call.argumentsExcerpt}</code>`)}
  </tr>`;
}

/**
ACT-63: every non-read call, across targets, that no human accepted through a confirmation.
*/
export function renderUnexpectedPage(view: UnexpectedView): string {
  return document(
    'Unexpected writes',
    html`<h2>Unexpected writes</h2>
      <p><a href="/account#actions">Back to the account page</a></p>
      <p>
        Every call that changed something — a write, a shell command or a browser action — and was
        not accepted by a human through a confirmation, newest first, across every target. A target
        that asks for confirmation on every non-read call appears here only when one was declined,
        cancelled, expired or refused.
      </p>
      ${when(view.calls.length === 0, () => html`<p>No unexpected write has been recorded.</p>`)}
      ${when(
        view.calls.length > 0,
        () =>
          html`<table>
            ${tableHead(UNEXPECTED_COLUMNS)}
            <tbody>
              ${view.calls.map((call) => unexpectedRow(call))}
            </tbody>
          </table>`,
      )}
      ${olderLink(UNEXPECTED_PATH, view.older)}`,
  );
}
