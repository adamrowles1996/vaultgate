import type { StoredAuditEvent } from './event.ts';

export type ExportFormat = 'jsonl' | 'csv';

export interface LineFormat<Record> {
  readonly contentType: string;
  readonly extension: string;
  /**
  Lines written before any record; CSV's header row, nothing for JSON Lines.
  */
  readonly header: readonly string[];
  /**
  One record as one line, terminator included.
  */
  readonly line: (record: Record) => string;
}

/**
A JSON Lines value; CSV writes an object as its JSON text.
*/
export type Cell = string | number | boolean | undefined | Readonly<Record<string, unknown>>;

/**
RFC 4180 §2: quote a field holding a comma, a double quote or a line break, doubling the quotes.
*/
const NEEDS_QUOTING = /[",\r\n]/;
const CSV_LINE_END = '\r\n';

function csvField(value: Cell): string {
  if (value === undefined) {
    return '';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Both formats over one column list: JSON Lines keys and CSV headers are
 * the same names, in the same order, and `at` is written as ISO 8601 in both.
 */
export function lineFormats<Record extends { readonly at: number }>(
  fields: readonly string[],
  cells: (record: Record) => Readonly<globalThis.Record<string, Cell>>,
): Readonly<globalThis.Record<ExportFormat, LineFormat<Record>>> {
  const values = (record: Record): Readonly<globalThis.Record<string, Cell>> => ({
    ...cells(record),
    at: new Date(record.at).toISOString(),
  });
  return {
    jsonl: {
      contentType: 'application/jsonl; charset=utf-8',
      extension: 'jsonl',
      header: [],
      line: (record) => {
        const row = values(record);
        return JSON.stringify(Object.fromEntries(fields.map((name) => [name, row[name]]))) + '\n';
      },
    },
    csv: {
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      header: [fields.join(',') + CSV_LINE_END],
      line: (record) => {
        const row = values(record);
        return fields.map((name) => csvField(row[name])).join(',') + CSV_LINE_END;
      },
    },
  };
}

/**
Column order of the `audit` stream (OPS-5).
*/
const AUDIT_FIELDS = [
  'id',
  'at',
  'category',
  'action',
  'outcome',
  'operatorId',
  'clientId',
  'tokenPrefix',
  'itemId',
  'field',
  'requestId',
  'ip',
  'durationMs',
  'details',
] as const;

export const FORMATS: Readonly<Record<ExportFormat, LineFormat<StoredAuditEvent>>> = lineFormats(
  AUDIT_FIELDS,
  (event) => ({
    id: event.id,
    category: event.category,
    action: event.action,
    outcome: event.outcome,
    operatorId: event.operatorId,
    clientId: event.clientId,
    tokenPrefix: event.tokenPrefix,
    itemId: event.itemId,
    field: event.field,
    requestId: event.requestId,
    ip: event.ip,
    durationMs: event.durationMs,
    details: event.details,
  }),
);

export function isExportFormat(value: string): value is ExportFormat {
  return Object.hasOwn(FORMATS, value);
}
