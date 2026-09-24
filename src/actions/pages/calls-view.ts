/**
 * What the call pages read (ACT-63): a target's last call for the account
 * section, one page of a target's calls for its history page, and one page
 * of the unexpected writes across every target. Reads only, through the
 * `action_calls` reader in `src/audit/`, so the pages never touch SQL.
 */
import {
  type CallFilter,
  listActionCalls,
  type StoredActionCall,
} from '../../audit/actions-query.ts';

import type { CallCursor, CallItem } from './calls.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
A target's newest call, for the Computers page (ACT-5).
*/
export interface LastCall {
  readonly at: string;
  readonly outcome: string;
}

/**
ACT-63: the page size of both call views; older rows are one link away.
*/
export const HISTORY_LIMIT = 50;

/**
 * The trail is read in full because retention (STORE-6) already bounds it;
 * the window belongs to the export, which takes one from the operator.
 */
const ALL_TIME = { from: 0, to: Number.MAX_SAFE_INTEGER };

/**
ACT-61: enough of the stored arguments to recognise what ran, never the whole 4 KiB in a table cell.
*/
const EXCERPT_CHARACTERS = 240;

export interface CallPage {
  readonly calls: readonly CallItem[];
  readonly older: CallCursor | undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function excerpt(call: StoredActionCall): string {
  const text = call.arguments;
  return text.length > EXCERPT_CHARACTERS || call.argumentsTruncated
    ? `${text.slice(0, EXCERPT_CHARACTERS)}…`
    : text;
}

/**
ACT-8: a call outlives its target, so the name links only while the target is still there.
*/
function linkTo(call: StoredActionCall, live: ReadonlySet<string>): string | undefined {
  return call.targetId !== undefined && live.has(call.targetId) ? call.targetId : undefined;
}

/**
Agent names by client id, for the Agent column; a client no longer connected shows its id.
*/
export type ClientNames = ReadonlyMap<string, string>;

const NO_NAMES: ClientNames = new Map();

function toItem(call: StoredActionCall, live: ReadonlySet<string>, names: ClientNames): CallItem {
  return {
    at: iso(call.at),
    targetId: linkTo(call, live),
    targetName: call.targetName,
    tool: call.tool,
    operation: call.operation ?? '',
    classification: call.classification ?? '',
    outcome: call.outcome,
    elicitation: call.elicitation,
    outputBytes: call.outputBytes,
    clientId: call.clientId,
    clientName: names.get(call.clientId) ?? call.clientId,
    argumentsExcerpt: excerpt(call),
  };
}

interface PageRequest {
  readonly filter: CallFilter;
  readonly cursor: CallCursor | undefined;
  readonly live: ReadonlySet<string>;
  readonly names: ClientNames;
}

function page(database: DatabaseSync, request: PageRequest): CallPage {
  const { filter, cursor, live, names } = request;
  const found = listActionCalls(database, { ...ALL_TIME, limit: HISTORY_LIMIT, cursor }, filter);
  return { calls: found.records.map((call) => toItem(call, live, names)), older: found.next };
}

/**
The Computers page's "last call" column: the newest row of the target, or nothing.
*/
export function lastCall(database: DatabaseSync, targetId: string): LastCall | undefined {
  const call = listActionCalls(database, { ...ALL_TIME, limit: 1 }, { targetId }).records[0];
  return call === undefined ? undefined : { at: iso(call.at), outcome: call.outcome };
}

export function targetCalls(
  database: DatabaseSync,
  targetId: string,
  cursor?: CallCursor,
  names: ClientNames = NO_NAMES,
): CallPage {
  return page(database, { filter: { targetId }, cursor, live: new Set([targetId]), names });
}

/**
 * ACT-63: every non-read call whose elicitation is not `accepted`, across
 * targets, newest first. `live` is the targets that still exist, so a row
 * left behind by a deleted one (ACT-8) names it without a broken link.
 */
export function unexpectedCalls(
  database: DatabaseSync,
  live: ReadonlySet<string>,
  cursor?: CallCursor,
  names: ClientNames = NO_NAMES,
): CallPage {
  return page(database, { filter: { unexpectedOnly: true }, cursor, live, names });
}

/**
 * ACT-63: every call across targets, newest first, for the Activity page.
 * `live` is the targets that still exist, as for the unexpected writes.
 */
export function recentCalls(
  database: DatabaseSync,
  live: ReadonlySet<string>,
  names: ClientNames = NO_NAMES,
): CallPage {
  return page(database, { filter: {}, cursor: undefined, live, names });
}

/**
The most unexpected writes the console counts; beyond it the badge says the cap and a plus.
*/
export const UNEXPECTED_COUNT_CAP = 100;

/**
ACT-63: how many unexpected writes there were since `since`, counted up to the cap.
*/
export function countUnexpectedSince(database: DatabaseSync, since: number): number {
  const window = { from: since, to: ALL_TIME.to, limit: UNEXPECTED_COUNT_CAP };
  return listActionCalls(database, window, { unexpectedOnly: true }).records.length;
}
