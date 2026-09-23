/**
 * The `action_calls` writer (spec §13.12, ACT-60, ACT-61): one row per call,
 * arguments scrubbed and capped, results never stored. A call that reaches
 * the connector is inserted before the run, which consumes the confirmation
 * nonce inside the same transaction (ACT-46), and completed by one update
 * when the call ends; a refused call is one insert. Nothing else updates or
 * deletes a row: retention is the store's maintenance task (ACT-62).
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../result.ts';
import { get, run, transaction } from '../storage/query.ts';

import { ActionError, type ActionOutcome } from './errors.ts';

import type { ElicitationOutcome } from './confirm.ts';
import type { OperationKind } from './policy.ts';
import type { DatabaseSync } from 'node:sqlite';

export type Elicitation = 'not_required' | ElicitationOutcome | 'unavailable' | 'invalid';

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
  readonly elicitation: Elicitation;
  readonly confirmationNonce: string | undefined;
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

const INSERT =
  'INSERT INTO action_calls (id, at, target_id, target_name, connector, revision, tool, ' +
  'session_id_hash, client_id, token_prefix, operation, classification, arguments, ' +
  'arguments_truncated, output_bytes, output_truncated, duration_ms, outcome, elicitation, ' +
  'confirmation_nonce, request_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const nonceRow = z.object({ id: z.string() });

/**
ACT-60: the arguments as JSON, cut at 4 KiB with the flag set.
*/
export function encodeArguments(value: unknown): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const text = JSON.stringify(value);
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length > ARGUMENTS_CAP_BYTES
    ? { text: bytes.subarray(0, ARGUMENTS_CAP_BYTES).toString('utf8'), truncated: true }
    : { text, truncated: false };
}

function orNull<T extends string | number>(value: T | undefined): T | null {
  return value ?? null;
}

function insert(database: DatabaseSync, row: CallRow): void {
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
    row.elicitation,
    orNull(row.confirmationNonce),
    orNull(row.requestId),
    orNull(row.ip),
  );
}

/**
ACT-46: whether a recorded call has already consumed the confirmation nonce.
*/
export function isNonceConsumed(database: DatabaseSync, nonce: string): boolean {
  return (
    get(database, 'SELECT id FROM action_calls WHERE confirmation_nonce = ?', nonceRow, nonce) !==
    undefined
  );
}

/**
 * Records a call. With a confirmation nonce the insert runs in a transaction
 * that first checks the nonce is unused, so a replayed confirmation fails
 * `confirmation_reused` before the connector runs (ACT-46); the unique index
 * is the backstop.
 */
export function recordCall(database: DatabaseSync, row: CallRow): Result<void, ActionError> {
  if (row.confirmationNonce === undefined) {
    insert(database, row);
    return ok(undefined);
  }
  const nonce = row.confirmationNonce;
  return transaction(database, () => {
    if (isNonceConsumed(database, nonce)) {
      return fail(new ActionError('confirmation_reused'));
    }
    insert(database, row);
    return ok(undefined);
  });
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
