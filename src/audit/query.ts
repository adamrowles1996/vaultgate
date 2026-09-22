import { z } from 'zod';

import { all } from '../storage/query.ts';

import { FORMATS } from './format.ts';

import type { StoredAuditEvent } from './event.ts';
import type { ExportFormat } from './format.ts';
import type { DatabaseSync } from 'node:sqlite';

const detailValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const detailsSchema = z.record(z.string(), detailValueSchema);
const toolErrorSchema = z.templateLiteral(['error:', z.string()]);
const outcomeSchema = z.union([
  z.literal('ok'),
  z.literal('failure'),
  z.literal('denied'),
  toolErrorSchema,
]);

const rowSchema = z.object({
  id: z.string(),
  at: z.number().int(),
  category: z.enum(['identity', 'oauth', 'mcp']),
  action: z.string(),
  outcome: outcomeSchema,
  operator_id: z.string().nullable(),
  client_id: z.string().nullable(),
  token_prefix: z.string().nullable(),
  item_id: z.string().nullable(),
  field: z.string().nullable(),
  request_id: z.string().nullable(),
  ip: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  details: z.string().nullable(),
});

type Row = z.output<typeof rowSchema>;

/**
A half-open window in milliseconds since the epoch: `from` inclusive, `to` exclusive.
*/
export interface AuditRange {
  readonly from: number;
  readonly to: number;
}

/**
Where the previous page ended; pages are newest first, so the next one is strictly older.
*/
interface AuditCursor {
  readonly at: number;
  readonly id: string;
}

interface ListAuditOptions extends AuditRange {
  readonly limit: number;
  readonly cursor?: AuditCursor | undefined;
}

interface AuditPage {
  readonly events: readonly StoredAuditEvent[];
  /**
  Absent on the last page.
  */
  readonly next: AuditCursor | undefined;
}

const COLUMNS =
  'id, at, category, action, outcome, operator_id, client_id, token_prefix, item_id, field, ' +
  'request_id, ip, duration_ms, details';

/**
Rows the export walks per query; bounds memory whatever the range holds.
*/
const EXPORT_PAGE_SIZE = 500;

function toRecord(row: Row): StoredAuditEvent {
  return {
    id: row.id,
    at: row.at,
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    operatorId: row.operator_id ?? undefined,
    clientId: row.client_id ?? undefined,
    tokenPrefix: row.token_prefix ?? undefined,
    itemId: row.item_id ?? undefined,
    field: row.field ?? undefined,
    requestId: row.request_id ?? undefined,
    ip: row.ip ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    details: row.details === null ? undefined : detailsSchema.parse(JSON.parse(row.details)),
  };
}

function nextCursor(rows: readonly Row[], limit: number): AuditCursor | undefined {
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return last === undefined ? undefined : { at: last.at, id: last.id };
}

/**
 * One page of events in the window, newest first, with keyset pagination on
 * `(at, id)` so a page never shifts when rows are appended or retired while
 * an operator is reading. Reads `limit + 1` rows to learn whether a next page
 * exists without a second query.
 */
export function listAuditEvents(database: DatabaseSync, options: ListAuditOptions): AuditPage {
  const { from, to, limit, cursor } = options;
  const keyset = cursor === undefined ? '' : ' AND (at < ?4 OR (at = ?4 AND id < ?5))';
  const sql =
    `SELECT ${COLUMNS} FROM audit_events WHERE at >= ?1 AND at < ?2${keyset} ` +
    'ORDER BY at DESC, id DESC LIMIT ?3';
  const parameters = cursor === undefined ? [] : [cursor.at, cursor.id];
  const rows = all(database, sql, rowSchema, from, to, limit + 1, ...parameters);
  return {
    events: rows.slice(0, limit).map((row) => toRecord(row)),
    next: nextCursor(rows, limit),
  };
}

function* exportLines(database: DatabaseSync, range: AuditRange, format: ExportFormat) {
  const { header, line } = FORMATS[format];
  yield* header;
  let cursor: AuditCursor | undefined;
  do {
    const page = listAuditEvents(database, { ...range, limit: EXPORT_PAGE_SIZE, cursor });
    for (const event of page.events) {
      yield line(event);
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/**
 * Every event in the window as a stream of lines (each with its terminator),
 * newest first, produced page by page as the consumer reads: JSON Lines, or
 * CSV per RFC 4180 with a header row (OPS-5).
 */
export function exportAuditEvents(
  database: DatabaseSync,
  range: AuditRange,
  format: ExportFormat,
): ReadableStream<string> {
  return ReadableStream.from(exportLines(database, range, format));
}
