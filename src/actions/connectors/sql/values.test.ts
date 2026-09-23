import { describe, expect, it } from 'vitest';

import { fitRows, toSqlScalar, toSqlString } from './values.ts';

function named(): number {
  return 1;
}

describe('sql result values', () => {
  it('ACT-24 null and undefined are null', () => {
    expect(toSqlScalar(null)).toBeNull();
    expect(toSqlScalar(undefined)).toBeNull();
  });

  it('ACT-24 strings, booleans and finite numbers pass through', () => {
    expect(toSqlScalar('a')).toBe('a');
    expect(toSqlScalar(false)).toBe(false);
    expect(toSqlScalar(1.5)).toBe(1.5);
  });

  it('ACT-24 a number JSON cannot hold becomes a string', () => {
    expect(toSqlScalar(Infinity)).toBe('Infinity');
    expect(toSqlScalar(NaN)).toBe('NaN');
  });

  it('ACT-24 a 64-bit integer becomes a string rather than losing digits', () => {
    expect(toSqlScalar(9_007_199_254_740_993n)).toBe('9007199254740993');
  });

  it('ACT-24 a date becomes ISO 8601', () => {
    const noon = new Date(Date.UTC(2026, 8, 23, 7, 30));
    expect(toSqlScalar(noon)).toBe('2026-09-23T07:30:00.000Z');
  });

  it('ACT-24 binary becomes base64, from a Buffer and from any other view', () => {
    expect(toSqlScalar(Buffer.from('hi', 'utf8'))).toBe('aGk=');
    expect(toSqlScalar(Uint8Array.from([104, 105]))).toBe('aGk=');
  });

  it('ACT-24 a structured value becomes its JSON text', () => {
    expect(toSqlScalar({ a: 1 })).toBe('{"a":1}');
    expect(toSqlScalar([1, 2])).toBe('[1,2]');
  });

  it('ACT-24 a value no driver returns still becomes a scalar rather than escaping', () => {
    expect(toSqlScalar(Symbol('x'))).toBe('Symbol(x)');
    expect(toSqlScalar(named)).toBe('named');
  });

  it('ACT-24 an exact numeric type is rendered as a string, and a null one stays null', () => {
    expect(toSqlString(12.5)).toBe('12.5');
    expect(toSqlString(null)).toBeNull();
    expect(toSqlString(undefined)).toBeNull();
  });
});

describe('fitting rows to the limits', () => {
  it('ACT-24 keeps every row when both limits allow it', () => {
    expect(fitRows([[1], [2]], 10, 1000)).toStrictEqual({
      rows: [[1], [2]],
      truncated: false,
      bytes: 8,
    });
  });

  it('ACT-24 drops rows beyond max_rows and says truncated', () => {
    expect(fitRows([[1], [2], [3]], 2, 1000)).toStrictEqual({
      rows: [[1], [2]],
      truncated: true,
      bytes: 8,
    });
  });

  it('ACT-52 drops a row whole rather than cutting a value at the output limit', () => {
    const rows = [['a'.repeat(40)], ['b'.repeat(40)]];
    const fitted = fitRows(rows, 10, 50);
    expect(fitted.rows).toStrictEqual([rows[0]]);
    expect(fitted.truncated).toBe(true);
    expect(fitted.bytes).toBe(45);
  });

  it('ACT-52 a single row larger than the output limit leaves no rows at all', () => {
    expect(fitRows([['a'.repeat(100)]], 10, 10)).toStrictEqual({
      rows: [],
      truncated: true,
      bytes: 0,
    });
  });
});
