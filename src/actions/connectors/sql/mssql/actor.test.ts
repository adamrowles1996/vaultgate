import { describe, expect, it } from 'vitest';

import {
  codedError as coded,
  fakeMssqlPool as fakePool,
  mssqlDriverOf as driverOf,
  sqlConnection as connection,
} from '../../../../test-support/fake-sql-drivers.ts';
import { rejection } from '../../../../test-support/fake-sql-session.ts';

import { CLEAR_ACTOR, SET_ACTOR } from './actor.ts';
import { openMssqlSession, type MssqlPool } from './session.ts';

const TAG = 'vg:Claude-Code:op-1:t=aaaaaaaaaaaa';

/**
A pool whose server refuses `sp_set_session_context`, and only that.
*/
function refusingActor(pool: MssqlPool): MssqlPool {
  return {
    ...pool,
    transaction() {
      const transaction = pool.transaction();
      return {
        ...transaction,
        request() {
          const command = transaction.request();
          return {
            ...command,
            query: (text: string) =>
              text.includes('sp_set_session_context')
                ? Promise.reject(coded('permission denied', 'EREQUEST'))
                : command.query(text),
          };
        },
      };
    },
  };
}

describe('the caller tag on a SQL Server write', () => {
  it('ACT-132 sets actor_id in the transaction before the statement, as a bound value, and clears it after', async () => {
    const pool = fakePool();
    const session = await openMssqlSession(driverOf(pool), connection({ mode: 'write' }));
    await session.query({ text: 'DELETE FROM t', params: [], maxRows: 1, callerTag: TAG });
    await session.close();
    expect(pool.commands).toStrictEqual([SET_ACTOR, 'DELETE FROM t', CLEAR_ACTOR]);
    expect(pool.inputs).toStrictEqual([['actor_id', TAG]]);
    expect(pool.steps).toStrictEqual(['begin', 'commit']);
    expect(SET_ACTOR).toBe("EXEC sp_set_session_context @key = N'actor_id', @value = @actor_id");
    expect(CLEAR_ACTOR).toBe("EXEC sp_set_session_context @key = N'actor_id', @value = NULL");
  });

  it('ACT-132 a failed write still clears actor_id, which does not roll back, before the rollback', async () => {
    const pool = fakePool({ queryError: coded('constraint', 'EREQUEST') });
    const session = await openMssqlSession(driverOf(pool), connection({ mode: 'write' }));
    const failure = await rejection(
      session.query({ text: 'DELETE FROM t', params: [], maxRows: 1, callerTag: TAG }),
    );
    expect(failure.code).toBe('upstream_error');
    expect(pool.commands).toStrictEqual([SET_ACTOR, 'DELETE FROM t', CLEAR_ACTOR]);
    expect(pool.steps).toStrictEqual(['begin', 'rollback']);
  });

  it('ACT-132 a server that refuses the tag never fails the write', async () => {
    const pool = fakePool();
    const session = await openMssqlSession(
      driverOf(refusingActor(pool)),
      connection({ mode: 'write' }),
    );
    const rows = await session.query({
      text: 'DELETE FROM t',
      params: [],
      maxRows: 1,
      callerTag: TAG,
    });
    expect(rows.rowsAffected).toBe(3);
    expect(pool.commands).toStrictEqual(['DELETE FROM t']);
    expect(pool.steps).toStrictEqual(['begin', 'commit']);
  });

  it('ACT-132 a read and an untagged write set nothing', async () => {
    const read = fakePool();
    const reader = await openMssqlSession(driverOf(read), connection());
    await reader.query({ text: 'SELECT 1', params: [], maxRows: 1, callerTag: TAG });
    const write = fakePool();
    const writer = await openMssqlSession(driverOf(write), connection({ mode: 'write' }));
    await writer.query({ text: 'DELETE FROM t', params: [], maxRows: 1 });
    expect(read.commands).toStrictEqual(['SELECT 1']);
    expect(write.commands).toStrictEqual(['DELETE FROM t']);
  });
});
