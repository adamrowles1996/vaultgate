/**
 * SQL Server's exact numerics under ACT-24. Tedious turns `decimal`,
 * `numeric`, `money` and `smallmoney` into a JavaScript double before
 * `mssql`'s own `valueHandler` registry is consulted — `readNumeric` computes
 * `unscaled * sign / 10 ** scale` and `readMoney` divides an int64 by 10 000,
 * both in `tedious/lib/value-parser.js` — and the registry's handler receives
 * only that double, so no hook the driver offers can preserve the digits.
 *
 * What the column metadata does carry is the declared scale, and that is
 * enough to be exact for every value whose unscaled integer fits a safe
 * integer: `toFixed(scale)` recovers it, so `decimal(10,2)` 3.50 leaves as
 * `"3.50"` rather than `"3.5"`. A value whose unscaled integer is larger was
 * already rounded before vaultgate saw it, and ACT-24 exists precisely to
 * stop an agent reading a silently wrong money column, so that value is
 * refused rather than rendered: `connector_fault` with
 * `detail.reason: "exact_numeric_precision"`, which the guide answers with
 * "cast the column to `varchar` in the statement".
 */
import { ActionError } from '../../../errors.ts';
import { toSqlString, type SqlScalar } from '../values.ts';

/**
The engine's own type names for the exact numerics; everything else is a scalar as it comes.
*/
export const EXACT_TYPES: ReadonlySet<string> = new Set([
  'decimal',
  'money',
  'numeric',
  'smallmoney',
]);

/**
`money` and `smallmoney` are fixed at four decimal places and carry no scale of their own.
*/
const FIXED_SCALES: Readonly<Record<string, number>> = { money: 4, smallmoney: 4 };

const RADIX = 10;

export interface ExactColumn {
  readonly name: string;
  /**
  The engine's own type name, lower-cased as the driver declares it.
  */
  readonly type: string;
  /**
  The declared number of decimal places, as the column metadata reports it.
  */
  readonly scale: number | undefined;
}

function scaleOf(column: ExactColumn): number | undefined {
  return FIXED_SCALES[column.type] ?? column.scale;
}

/**
 * ACT-24: an exact numeric as the string the column declared, or a refusal
 * when the driver has already lost digits the string would misreport.
 */
export function exactScalar(value: unknown, column: ExactColumn): SqlScalar {
  if (typeof value !== 'number') {
    return toSqlString(value);
  }
  const scale = scaleOf(column);
  if (Math.abs(value) * RADIX ** (scale ?? 0) > Number.MAX_SAFE_INTEGER) {
    throw new ActionError('connector_fault', {
      reason: 'exact_numeric_precision',
      column: column.name,
    });
  }
  return scale === undefined ? String(value) : value.toFixed(scale);
}
