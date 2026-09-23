import { z } from 'zod';

import { FORMATS } from './format.ts';
import {
  type AuditRange,
  exportPages,
  type KeysetSource,
  listPage,
  type Page,
  type PageOptions,
} from './keyset.ts';

import type { StoredAuditEvent } from './event.ts';
import type { ExportFormat } from './format.ts';
import type { DatabaseSync } from 'node:sqlite';

export type { AuditRange } from './keyset.ts';

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
  category: z.enum(['identity', 'oauth', 'mcp', 'actions']),
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

const SOURCE: KeysetSource<Row, StoredAuditEvent> = {
  table: 'audit_events',
  columns:
    'id, at, category, action, outcome, operator_id, client_id, token_prefix, item_id, field, ' +
    'request_id, ip, duration_ms, details',
  rowSchema,
  toRecord,
};

/**
One page of events in the window, newest first, with keyset pagination on `(at, id)`.
*/
export function listAuditEvents(
  database: DatabaseSync,
  options: PageOptions,
): Page<StoredAuditEvent> {
  return listPage(database, SOURCE, options);
}

/**
 * Every event in the window as a stream of lines, newest first, produced
 * page by page as the consumer reads: JSON Lines, or CSV per RFC 4180 with
 * a header row (OPS-5).
 */
export function exportAuditEvents(
  database: DatabaseSync,
  range: AuditRange,
  format: ExportFormat,
): ReadableStream<string> {
  return exportPages((options) => listAuditEvents(database, options), range, FORMATS[format]);
}
