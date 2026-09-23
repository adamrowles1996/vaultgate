import { describe, expect, it } from 'vitest';

import {
  fakeMssqlPool as fakePool,
  mssqlDriverOf as driverOf,
  sqlConnection,
} from '../../../../test-support/fake-sql-drivers.ts';
import { rejection } from '../../../../test-support/fake-sql-session.ts';

import { openMssqlSession } from './session.ts';

import type { SqlConnection } from '../session.ts';

function connection(overrides: Partial<SqlConnection> = {}): SqlConnection {
  return sqlConnection({ port: 1433, ...overrides });
}

/**
 * ACT-24 over the injected driver: what the session makes of the doubles
 * Tedious has already built out of SQL Server's exact numerics.
 */
describe('SQL Server exact numerics', () => {
  /**
   * The regression test for the shipped defect: Tedious parses an exact
   * numeric into a double before anything vaultgate can reach, so the string
   * ACT-24 asks for was a rounded one. The declared scale recovers every value
   * whose unscaled integer is a safe integer.
   */
  it('ACT-24 a decimal leaves at the scale the column declares, not as a rounded double', async () => {
    const pool = fakePool({
      answers: {
        columns: [[{ name: 'total', type: { declaration: 'decimal' }, scale: 2 }]],
        recordset: [[3.5], [0.07], [null]],
        rowsAffected: [3],
      },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT total', params: [], maxRows: 3 });
    await session.close();
    expect(rows.rows).toStrictEqual([['3.50'], ['0.07'], [null]]);
  });

  it('ACT-24 money and smallmoney carry their four fixed decimal places', async () => {
    const pool = fakePool({
      answers: {
        columns: [
          [
            { name: 'paid', type: { declaration: 'money' } },
            { name: 'fee', type: { declaration: 'smallmoney' } },
          ],
        ],
        recordset: [[12.5, 1]],
        rowsAffected: [1],
      },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT paid, fee', params: [], maxRows: 1 });
    await session.close();
    expect(rows.rows).toStrictEqual([['12.5000', '1.0000']]);
  });

  it('ACT-24 a decimal whose scale the metadata omits is the value as it stands', async () => {
    const pool = fakePool({
      answers: {
        columns: [[{ name: 'total', type: { declaration: 'numeric' } }]],
        recordset: [[12.5]],
        rowsAffected: [1],
      },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT total', params: [], maxRows: 1 });
    await session.close();
    expect(rows.rows).toStrictEqual([['12.5']]);
  });

  it('ACT-24 a decimal the driver has already rounded is refused, never answered as a number', async () => {
    const pool = fakePool({
      answers: {
        columns: [[{ name: 'total', type: { declaration: 'decimal' }, scale: 10 }]],
        // What Tedious hands over for CAST(1234567890123456789.12345 AS
        // decimal(38,10)): the unscaled integer divided by 10**10 as a double,
        // already rounded, which is the whole of the defect.
        recordset: [[1.2345678901234568e18]],
        rowsAffected: [1],
      },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const failure = await rejection(
      session.query({ text: 'SELECT total', params: [], maxRows: 1 }),
    );
    await session.close();
    expect(failure.code).toBe('connector_fault');
    expect(failure.detail).toStrictEqual({
      reason: 'exact_numeric_precision',
      column: 'total',
    });
  });

  it('ACT-24 a decimal the driver hands back as a string is kept whole', async () => {
    const pool = fakePool({
      answers: {
        columns: [[{ name: 'total', type: { declaration: 'decimal' }, scale: 2 }]],
        recordset: [['1234567890123456789.12']],
        rowsAffected: [1],
      },
    });
    const session = await openMssqlSession(driverOf(pool), connection());
    const rows = await session.query({ text: 'SELECT total', params: [], maxRows: 1 });
    await session.close();
    expect(rows.rows).toStrictEqual([['1234567890123456789.12']]);
  });
});
