/**
 * Result values as JSON scalars (ACT-24): dates as ISO 8601, 64-bit integers
 * and decimals as strings (a JSON number cannot hold either without losing
 * digits), everything else as the scalar it is. Binary is the one value the
 * driver hands over unencoded: ACT-24 renders it as base64 and the engine's
 * scrubber does that, after it has scrubbed the bytes (ACT-51). And
 * the fit of rows into the target's row and output limits (§13.11): rows are
 * dropped whole, so a value is never cut in half and the guard band of
 * ACT-52 has nothing to catch.
 */
export type SqlScalar = string | number | boolean | null;

/**
 * A value as it leaves the driver. Binary stays a `Uint8Array` all the way to
 * the engine, which scrubs its bytes and then base64-encodes it (ACT-51):
 * base64 is positional, so encoding it here would put the credential in front
 * of a scrub table that cannot match it.
 */
export type SqlValue = SqlScalar | Uint8Array;

export type SqlRow = readonly SqlValue[];

function objectScalar(value: unknown): SqlValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value instanceof Uint8Array ? value : JSON.stringify(value);
}

export function toSqlScalar(value: unknown): SqlValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return value.toString();
  }
  return typeof value === 'function' ? value.name : objectScalar(value);
}

/**
A value the engine parses as a number but cannot hold exactly; ACT-24 asks for it as a string.
*/
export function toSqlString(value: unknown): SqlScalar {
  return value === null || value === undefined ? null : String(toSqlScalar(value));
}

const BASE64_BLOCK = 4;
const BASE64_BYTES_PER_BLOCK = 3;

/**
The serialised size of one row, counting a binary value as the base64 the engine will send (ACT-24).
*/
function rowSize(row: SqlRow): number {
  let bytes = 0;
  for (const value of row) {
    bytes +=
      value instanceof Uint8Array
        ? Math.ceil(value.byteLength / BASE64_BYTES_PER_BLOCK) * BASE64_BLOCK + 2
        : Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  return bytes + Math.max(row.length - 1, 0) + 3;
}

export interface FittedRows {
  readonly rows: readonly SqlRow[];
  readonly truncated: boolean;
  /**
  The serialised size of the rows returned; the `action_calls` row records it as `output_bytes`.
  */
  readonly bytes: number;
}

/**
 * ACT-24, §13.11: at most `maxRows` rows and at most `maxBytes` of them. A
 * row that would cross either limit is dropped with every row after it and
 * the result is `truncated`.
 */
export function fitRows(rows: readonly SqlRow[], maxRows: number, maxBytes: number): FittedRows {
  const kept: SqlRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = rowSize(row);
    if (kept.length >= maxRows || bytes + size > maxBytes) {
      return { rows: kept, truncated: true, bytes };
    }
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, truncated: false, bytes };
}
