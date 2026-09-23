/**
 * The audit export as both entrypoints drive it (OPS-5, ACT-62): the
 * account page form and `cli.ts` each collect `from`, `to`, `format` and
 * `stream` as text, validate them here, and stream the lines to wherever
 * they are going.
 */
import { pipeline } from 'node:stream/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { fail, ok, type Result } from '../result.ts';

import { ACTION_CALL_FORMATS, exportActionCalls } from './actions-query.ts';
import { FORMATS, isExportFormat } from './format.ts';
import { exportAuditEvents } from './query.ts';

import type { ExportFormat } from './format.ts';
import type { AuditRange } from './keyset.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
`audit` is the audit events of MCP-13/14; `actions` the `action_calls` rows of ACT-60.
*/
export type ExportStream = 'audit' | 'actions';

export interface ExportRequest extends AuditRange {
  readonly format: ExportFormat;
  readonly stream: ExportStream;
}

/**
The inputs as text, before validation; absent when the form or command line omitted them.
*/
export interface ExportInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly format?: string | undefined;
  readonly stream?: string | undefined;
}

export const USAGE =
  'usage: node dist/cli.js audit export --from <iso-8601> --to <iso-8601> ' +
  '[--format jsonl|csv] [--stream audit|actions]';

const DEFAULT_FORMAT: ExportFormat = 'jsonl';
const DEFAULT_STREAM: ExportStream = 'audit';

interface Stream {
  readonly header: (format: ExportFormat) => readonly string[];
  readonly lines: (
    database: DatabaseSync,
    range: AuditRange,
    format: ExportFormat,
  ) => ReadableStream<string>;
}

const STREAMS: Readonly<Record<ExportStream, Stream>> = {
  audit: { header: (format) => FORMATS[format].header, lines: exportAuditEvents },
  actions: { header: (format) => ACTION_CALL_FORMATS[format].header, lines: exportActionCalls },
};

function isExportStream(value: string): value is ExportStream {
  return Object.hasOwn(STREAMS, value);
}

function parseInstant(name: string, value: string | undefined): Result<number> {
  if (value === undefined) {
    return fail(new Error(`${name} is required`));
  }
  const instant = Date.parse(value);
  return Number.isNaN(instant)
    ? fail(new Error(`${name} is not an ISO 8601 date or date-time: ${value}`))
    : ok(instant);
}

/**
 * Validates the export inputs: both instants ISO 8601 with `from` before
 * `to` (a half-open window), the format one of the two supported and the
 * stream one of the two known.
 */
export function parseExportRequest(input: ExportInput): Result<ExportRequest> {
  const from = parseInstant('from', input.from);
  if (!from.ok) {
    return from;
  }
  const to = parseInstant('to', input.to);
  if (!to.ok) {
    return to;
  }
  if (from.value >= to.value) {
    return fail(new Error('from must be before to'));
  }
  const format = input.format ?? DEFAULT_FORMAT;
  if (!isExportFormat(format)) {
    return fail(new Error(`format must be jsonl or csv, not ${format}`));
  }
  const stream = input.stream ?? DEFAULT_STREAM;
  return isExportStream(stream)
    ? ok({ from: from.value, to: to.value, format, stream })
    : fail(new Error(`stream must be audit or actions, not ${stream}`));
}

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string' },
  format: { type: 'string' },
  stream: { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

interface ParsedCommandLine {
  readonly values: ExportInput;
  readonly positionals: readonly string[];
}

function parseCommandLine(argv: readonly string[]): Result<ParsedCommandLine> {
  try {
    return ok(
      parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }),
    );
  } catch (error) {
    return fail(new Error(`invalid arguments: ${String(error)}`, { cause: error }));
  }
}

/**
`audit export --from … --to … [--format …] [--stream …]` from the command line, after the node and script paths.
*/
export function parseExportArguments(argv: readonly string[]): Result<ExportRequest> {
  const parsed = parseCommandLine(argv);
  if (!parsed.ok) {
    return parsed;
  }
  const command = parsed.value.positionals.join(' ');
  return command === 'audit export'
    ? parseExportRequest(parsed.value.values)
    : fail(new Error(`unknown command: ${command}`));
}

/**
The requested stream's lines over the window, newest first (the account page download).
*/
export function exportLines(
  database: DatabaseSync,
  request: ExportRequest,
): ReadableStream<string> {
  return STREAMS[request.stream].lines(database, request, request.format);
}

/**
 * Streams the export to `output` with back-pressure and leaves `output`
 * open (it may be `process.stdout`). No database means no store has been
 * created yet, which exports as empty: the CSV header alone, or nothing.
 */
export async function writeAuditExport(
  database: DatabaseSync | undefined,
  request: ExportRequest,
  output: NodeJS.WritableStream,
): Promise<void> {
  const lines =
    database === undefined
      ? STREAMS[request.stream].header(request.format)
      : exportLines(database, request);
  await pipeline(lines, output, { end: false });
}
