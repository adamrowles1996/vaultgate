/**
 * The `action_calls` writer (spec §13.12, ACT-60, ACT-61): one row per call,
 * arguments scrubbed and capped, results never stored. A call that reaches
 * the connector is inserted before the run and completed by one update when
 * the call ends; a refused call is one insert. Nothing else updates or
 * deletes a row: retention is the store's maintenance task (ACT-62).
 *
 * The table keeps its `elicitation` and `confirmation_nonce` columns for the
 * rows written while vaultgate asked for its own confirmations (§13.8,
 * withdrawn): a row written now records `not_required` and no nonce.
 */
import { createHash } from 'node:crypto';

import { run } from '../storage/query.ts';

import type { ActionOutcome } from './errors.ts';
import type { OperationKind } from './policy.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
The outcome a reserved row carries until the call completes; left behind only by a process that died mid-call.
*/
export const INTERRUPTED_OUTCOME = 'error:interrupted';

export type CallOutcome = ActionOutcome | typeof INTERRUPTED_OUTCOME;

export interface CallRow {
  readonly id: string;
  readonly at: number;
  readonly targetId: string | undefined;
  readonly targetName: string;
  readonly connector: string | undefined;
  readonly revision: number | undefined;
  readonly tool: string;
  readonly sessionIdHash: string | undefined;
  readonly clientId: string;
  readonly tokenPrefix: string;
  readonly operation: OperationKind | undefined;
  readonly classification: string | undefined;
  /**
  Already scrubbed; serialised and capped here.
  */
  readonly arguments: unknown;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly outcome: CallOutcome;
  readonly requestId: string | undefined;
  readonly ip: string | undefined;
}

export interface CallCompletion {
  readonly outcome: ActionOutcome;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
}

const ARGUMENTS_CAP_BYTES = 4096;

/**
What a row written today records in the columns of the withdrawn confirmation (§13.8).
*/
const NOT_REQUIRED = 'not_required';

const INSERT =
  'INSERT INTO action_calls (id, at, target_id, target_name, connector, revision, tool, ' +
  'session_id_hash, client_id, token_prefix, operation, classification, arguments, ' +
  'arguments_truncated, output_bytes, output_truncated, duration_ms, outcome, elicitation, ' +
  'confirmation_nonce, request_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)';

/**
 * ACT-60: the arguments as JSON, cut at 4 KiB. What is cut is named: the
 * excerpt carries the byte counts and the SHA-256 of the whole of it, so the
 * ACT-63 review view shows an operator that it is reading part of a record
 * and gives them something to check the rest against. `ssh` and `winrm` also
 * have ACT-88's full command in `classification`; `sql` has nothing else, and
 * a 64 KiB statement would otherwise hide its operative clause from the one
 * view that exists to review every write.
 */
export function encodeArguments(value: unknown): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const text = JSON.stringify(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ARGUMENTS_CAP_BYTES) {
    return { text, truncated: false };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const excerpt = bytes.subarray(0, ARGUMENTS_CAP_BYTES).toString('utf8');
  return {
    text:
      `${excerpt}\n[vaultgate: ${String(ARGUMENTS_CAP_BYTES)} of ${String(bytes.length)} bytes ` +
      `shown; sha256 of the whole is ${sha256}]`,
    truncated: true,
  };
}

function orNull<T extends string | number>(value: T | undefined): T | null {
  return value ?? null;
}

/**
Records a call: one insert, before the run for a call that reaches the connector (ACT-62).
*/
export function recordCall(database: DatabaseSync, row: CallRow): void {
  const encoded = encodeArguments(row.arguments);
  run(
    database,
    INSERT,
    row.id,
    row.at,
    orNull(row.targetId),
    row.targetName,
    orNull(row.connector),
    orNull(row.revision),
    row.tool,
    orNull(row.sessionIdHash),
    row.clientId,
    row.tokenPrefix,
    orNull(row.operation),
    orNull(row.classification),
    encoded.text,
    encoded.truncated ? 1 : 0,
    row.outputBytes,
    row.outputTruncated ? 1 : 0,
    row.durationMs,
    row.outcome,
    NOT_REQUIRED,
    orNull(row.requestId),
    orNull(row.ip),
  );
}

/**
Fills in what only the run could tell: outcome, output size, truncation and duration.
*/
export function completeCall(database: DatabaseSync, id: string, completion: CallCompletion): void {
  run(
    database,
    'UPDATE action_calls SET outcome = ?, output_bytes = ?, output_truncated = ?, duration_ms = ? WHERE id = ?',
    completion.outcome,
    completion.outputBytes,
    completion.outputTruncated ? 1 : 0,
    completion.durationMs,
    id,
  );
}
