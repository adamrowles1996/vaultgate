import type { StoredAuditEvent } from './event.ts';

export type ExportFormat = 'jsonl' | 'csv';

export interface LineFormat {
  readonly contentType: string;
  readonly extension: string;
  /**
  Lines written before any event; CSV's header row, nothing for JSON Lines.
  */
  readonly header: readonly string[];
  /**
  One event as one line, terminator included.
  */
  readonly line: (event: StoredAuditEvent) => string;
}

/**
Column order shared by both formats; JSON Lines keys and CSV headers are the same names.
*/
const FIELDS = [
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

/**
RFC 4180 §2: quote a field holding a comma, a double quote or a line break, doubling the quotes.
*/
const NEEDS_QUOTING = /[",\r\n]/;
const CSV_LINE_END = '\r\n';

function csvField(value: string | number | undefined): string {
  if (value === undefined) {
    return '';
  }
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(event: StoredAuditEvent): string {
  const { details, at, ...rest } = event;
  const cells = FIELDS.map((name) => {
    switch (name) {
      case 'at': {
        return csvField(new Date(at).toISOString());
      }
      case 'details': {
        return csvField(details === undefined ? undefined : JSON.stringify(details));
      }
      default: {
        return csvField(rest[name]);
      }
    }
  });
  return cells.join(',') + CSV_LINE_END;
}

function jsonLine(event: StoredAuditEvent): string {
  const { id, at, ...rest } = event;
  return JSON.stringify({ id, at: new Date(at).toISOString(), ...rest }) + '\n';
}

export const FORMATS: Readonly<Record<ExportFormat, LineFormat>> = {
  jsonl: {
    contentType: 'application/jsonl; charset=utf-8',
    extension: 'jsonl',
    header: [],
    line: jsonLine,
  },
  csv: {
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
    header: [FIELDS.join(',') + CSV_LINE_END],
    line: csvLine,
  },
};

export function isExportFormat(value: string): value is ExportFormat {
  return Object.hasOwn(FORMATS, value);
}
