/**
 * The `actions` export stream (ACT-62): `action_calls` rows as JSON Lines
 * or CSV over the same half-open window and keyset walk as the audit
 * events. The writer lives in `src/actions/`; this reader knows the row
 * shape only, so `src/audit/` never imports the actions layer.
 */
import { z } from 'zod';

import { type ExportFormat, type LineFormat, lineFormats } from './format.ts';
import {
  type AuditRange,
  exportPages,
  type KeysetSource,
  listPage,
  type Page,
  type PageOptions,
} from './keyset.ts';

import type { DatabaseSync } from 'node:sqlite';

const flag = z.number().transform((value) => value === 1);
const optional = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);

const rowSchema = z.object({
  id: z.string(),
  at: z.number().int(),
  target_id: optional,
  target_name: z.string(),
  connector: optional,
  revision: z.number().int().nullable(),
  tool: z.string(),
  session_id_hash: optional,
  client_id: z.string(),
  token_prefix: z.string(),
  operation: optional,
  classification: optional,
  arguments: z.string(),
  arguments_truncated: flag,
  output_bytes: z.number().int(),
  output_truncated: flag,
  duration_ms: z.number().int(),
  outcome: z.string(),
  elicitation: z.string(),
  confirmation_nonce: optional,
  request_id: optional,
  ip: optional,
});

type Row = z.output<typeof rowSchema>;

/**
One `action_calls` row (ACT-60), arguments as the stored JSON text (possibly cut at 4 KiB).
*/
export interface StoredActionCall {
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
  readonly operation: string | undefined;
  readonly classification: string | undefined;
  readonly arguments: string;
  readonly argumentsTruncated: boolean;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly outcome: string;
  readonly elicitation: string;
  readonly confirmationNonce: string | undefined;
  readonly requestId: string | undefined;
  readonly ip: string | undefined;
}

const FIELDS = [
  'id',
  'at',
  'targetId',
  'targetName',
  'connector',
  'revision',
  'tool',
  'sessionIdHash',
  'clientId',
  'tokenPrefix',
  'operation',
  'classification',
  'arguments',
  'argumentsTruncated',
  'outputBytes',
  'outputTruncated',
  'durationMs',
  'outcome',
  'elicitation',
  'confirmationNonce',
  'requestId',
  'ip',
] as const;

function toRecord(row: Row): StoredActionCall {
  return {
    id: row.id,
    at: row.at,
    targetId: row.target_id,
    targetName: row.target_name,
    connector: row.connector,
    revision: row.revision ?? undefined,
    tool: row.tool,
    sessionIdHash: row.session_id_hash,
    clientId: row.client_id,
    tokenPrefix: row.token_prefix,
    operation: row.operation,
    classification: row.classification,
    arguments: row.arguments,
    argumentsTruncated: row.arguments_truncated,
    outputBytes: row.output_bytes,
    outputTruncated: row.output_truncated,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    elicitation: row.elicitation,
    confirmationNonce: row.confirmation_nonce,
    requestId: row.request_id,
    ip: row.ip,
  };
}

const SOURCE: KeysetSource<Row, StoredActionCall> = {
  table: 'action_calls',
  columns: '*',
  rowSchema,
  toRecord,
};

export const ACTION_CALL_FORMATS: Readonly<Record<ExportFormat, LineFormat<StoredActionCall>>> =
  lineFormats(FIELDS, (call) => ({ ...call }));

/**
One page of calls in the window, newest first, for the account page's views (ACT-63).
*/
export function listActionCalls(
  database: DatabaseSync,
  options: PageOptions,
): Page<StoredActionCall> {
  return listPage(database, SOURCE, options);
}

/**
Every call in the window as a stream of lines, newest first (ACT-62).
*/
export function exportActionCalls(
  database: DatabaseSync,
  range: AuditRange,
  format: ExportFormat,
): ReadableStream<string> {
  return exportPages(
    (options) => listActionCalls(database, options),
    range,
    ACTION_CALL_FORMATS[format],
  );
}
