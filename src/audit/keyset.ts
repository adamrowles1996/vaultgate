/**
 * Keyset pagination and streaming export shared by the two audit streams
 * (`audit_events`, OPS-5; `action_calls`, ACT-62): pages newest first on
 * `(at, id)` so a page never shifts when rows are appended or retired while
 * an operator is reading, and the export walks the pages as the consumer
 * reads them, so memory is bounded whatever the range holds.
 */
import { all } from '../storage/query.ts';

import type { LineFormat } from './format.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';

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
export interface KeysetCursor {
  readonly at: number;
  readonly id: string;
}

export interface PageOptions extends AuditRange {
  readonly limit: number;
  readonly cursor?: KeysetCursor | undefined;
}

export interface Page<Record> {
  readonly records: readonly Record[];
  /**
  Absent on the last page.
  */
  readonly next: KeysetCursor | undefined;
}

/**
A table with `at` and `id` columns, the columns to read and how a row becomes a record.
*/
export interface KeysetSource<Row extends KeysetCursor, Record> {
  readonly table: string;
  readonly columns: string;
  readonly rowSchema: z.ZodType<Row>;
  readonly toRecord: (row: Row) => Record;
}

/**
Rows the export walks per query.
*/
const EXPORT_PAGE_SIZE = 500;

/**
 * One page in the window, newest first. Reads `limit + 1` rows to learn
 * whether a next page exists without a second query.
 */
export function listPage<Row extends KeysetCursor, Record>(
  database: DatabaseSync,
  source: KeysetSource<Row, Record>,
  options: PageOptions,
): Page<Record> {
  const { from, to, limit, cursor } = options;
  const keyset = cursor === undefined ? '' : ' AND (at < ?4 OR (at = ?4 AND id < ?5))';
  const sql =
    `SELECT ${source.columns} FROM ${source.table} WHERE at >= ?1 AND at < ?2${keyset} ` +
    'ORDER BY at DESC, id DESC LIMIT ?3';
  const parameters = cursor === undefined ? [] : [cursor.at, cursor.id];
  const rows = all(database, sql, source.rowSchema, from, to, limit + 1, ...parameters);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    records: rows.slice(0, limit).map((row) => source.toRecord(row)),
    next: last === undefined ? undefined : { at: last.at, id: last.id },
  };
}

function* lines<Record>(
  pageOf: (options: PageOptions) => Page<Record>,
  range: AuditRange,
  format: LineFormat<Record>,
): Generator<string> {
  yield* format.header;
  let cursor: KeysetCursor | undefined;
  do {
    const page = pageOf({ ...range, limit: EXPORT_PAGE_SIZE, cursor });
    for (const record of page.records) {
      yield format.line(record);
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/**
Every record in the window as a stream of lines (each with its terminator), newest first, page by page.
*/
export function exportPages<Record>(
  pageOf: (options: PageOptions) => Page<Record>,
  range: AuditRange,
  format: LineFormat<Record>,
): ReadableStream<string> {
  return ReadableStream.from(lines(pageOf, range, format));
}
