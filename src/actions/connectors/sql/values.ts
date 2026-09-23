/**
 * Result values as JSON scalars (ACT-24): dates as ISO 8601, binary as
 * base64, 64-bit integers and decimals as strings (a JSON number cannot hold
 * either without losing digits), everything else as the scalar it is. And
 * the fit of rows into the target's row and output limits (§13.11): rows are
 * dropped whole, so a value is never cut in half and the guard band of
 * ACT-52 has nothing to catch.
 */
export type SqlScalar = string | number | boolean | null;

export type SqlRow = readonly SqlScalar[];

function objectScalar(value: unknown): SqlScalar {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
    : JSON.stringify(value);
}

export function toSqlScalar(value: unknown): SqlScalar {
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
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (kept.length >= maxRows || bytes + size > maxBytes) {
      return { rows: kept, truncated: true, bytes };
    }
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, truncated: false, bytes };
}
