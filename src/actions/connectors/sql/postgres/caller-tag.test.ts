import { describe, expect, it } from 'vitest';

import {
  FAILING_STATEMENT,
  READ_TAG,
  settingsPostgresClient,
} from '../../../../test-support/fake-postgres-settings.ts';
import {
  postgresDriverOf as driverOf,
  sqlConnection as connection,
} from '../../../../test-support/fake-sql-drivers.ts';
import { rejection } from '../../../../test-support/fake-sql-session.ts';

import { openPostgresSession, SET_CALLER_TAG } from './session.ts';

import type { SqlRequest } from '../session.ts';

const ALICE = 'vg:Claude-Code:op-1:t=aaaaaaaaaaaa';
const BOB = 'vg:Claude:op-1:t=bbbbbbbbbbbb';

function readTag(callerTag?: string): SqlRequest {
  return {
    text: READ_TAG,
    params: [],
    maxRows: 2,
    ...(callerTag !== undefined && { callerTag }),
  };
}

describe('the caller tag on a PostgreSQL statement', () => {
  it('ACT-132 sets both settings transaction-locally after BEGIN and before the statement, the tag a bound value', async () => {
    const client = settingsPostgresClient();
    const session = await openPostgresSession(driverOf(client), connection({ mode: 'write' }));
    await session.query(readTag(ALICE));
    await session.close();
    expect(SET_CALLER_TAG).toBe(
      "SELECT set_config('application_name', $1, true), set_config('app.actor_id', $1, true)",
    );
    expect(client.texts.slice(0, 3)).toStrictEqual(['BEGIN', SET_CALLER_TAG, READ_TAG]);
    expect(client.texts.at(-1)).toBe('COMMIT');
  });

  it('ACT-132 (i) a tagged statement sees its own tag through current_setting', async () => {
    const client = settingsPostgresClient();
    const session = await openPostgresSession(driverOf(client), connection());
    const rows = await session.query(readTag(ALICE));
    await session.close();
    expect(rows.rows).toStrictEqual([[ALICE, ALICE]]);
  });

  it('ACT-132 (ii) calls on one reused connection each see only their own tag, and an untagged call sees an empty value', async () => {
    const pooled = settingsPostgresClient();
    const first = await openPostgresSession(driverOf(pooled), connection({ mode: 'write' }));
    const alice = await first.query(readTag(ALICE));
    const bob = await first.query(readTag(BOB));
    const second = await openPostgresSession(driverOf(pooled), connection());
    const nobody = await second.query(readTag());
    expect(alice.rows).toStrictEqual([[ALICE, ALICE]]);
    expect(bob.rows).toStrictEqual([[BOB, BOB]]);
    expect(nobody.rows).toStrictEqual([['vaultgate', '']]);
    expect(pooled.settings()).toStrictEqual({ app: 'vaultgate', actor: '' });
  });

  it('ACT-132 (iii) a statement that fails still rolls back and leaves no setting behind', async () => {
    const client = settingsPostgresClient();
    const session = await openPostgresSession(driverOf(client), connection({ mode: 'write' }));
    const error = await rejection(
      session.query({ text: FAILING_STATEMENT, params: [], maxRows: 2, callerTag: ALICE }),
    );
    expect(error.code).toBe('upstream_error');
    expect(client.texts).toStrictEqual(['BEGIN', SET_CALLER_TAG, FAILING_STATEMENT, 'ROLLBACK']);
    expect(client.settings()).toStrictEqual({ app: 'vaultgate', actor: '' });
    const after = await session.query(readTag());
    expect(after.rows).toStrictEqual([['vaultgate', '']]);
  });

  it('ACT-132 a call with no tag sets nothing at all', async () => {
    const client = settingsPostgresClient();
    const session = await openPostgresSession(driverOf(client), connection());
    await session.query(readTag());
    expect(client.texts).not.toContain(SET_CALLER_TAG);
    expect(client.settings()).toStrictEqual({ app: 'vaultgate', actor: null });
  });
});
