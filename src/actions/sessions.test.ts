import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all, run } from '../storage/query.ts';
import { openTestDatabase } from '../test-support/database.ts';

import { closeSessions, countOpenSessions } from './sessions.ts';

import type { DatabaseSync } from 'node:sqlite';

const INSERT =
  'INSERT INTO action_sessions (id_hash, target_id, client_id, token_prefix, opened_at, ' +
  'last_used_at, expires_at, closed_at, close_reason, calls) VALUES (?, ?, ?, ?, 0, 0, 900, ?, ?, 0)';

const rowSchema = z.object({
  id_hash: z.string(),
  closed_at: z.number().nullable(),
  close_reason: z.string().nullable(),
});

function seeded(): DatabaseSync {
  const database = openTestDatabase();
  run(database, INSERT, 's1', 't1', 'c1', 'p', null, null);
  run(database, INSERT, 's2', 't1', 'c2', 'p', null, null);
  run(database, INSERT, 's3', 't2', 'c1', 'p', null, null);
  run(database, INSERT, 's4', 't1', 'c1', 'p', 5, 'agent');
  return database;
}

function state(database: DatabaseSync): readonly z.output<typeof rowSchema>[] {
  return all(
    database,
    'SELECT id_hash, closed_at, close_reason FROM action_sessions ORDER BY id_hash',
    rowSchema,
  );
}

describe('closeSessions', () => {
  it('ACT-8 ACT-96 closes every open session of a target with the reason and the time, leaving closed ones alone', () => {
    const database = seeded();
    expect(closeSessions(database, { targetId: 't1' }, 'target_changed', 42)).toBe(2);
    expect(state(database)).toStrictEqual([
      { id_hash: 's1', closed_at: 42, close_reason: 'target_changed' },
      { id_hash: 's2', closed_at: 42, close_reason: 'target_changed' },
      { id_hash: 's3', closed_at: null, close_reason: null },
      { id_hash: 's4', closed_at: 5, close_reason: 'agent' },
    ]);
  });

  it('ACT-10 ACT-96 closes every open session of a client across targets as revoked', () => {
    const database = seeded();
    expect(closeSessions(database, { clientId: 'c1' }, 'revoked', 7)).toBe(2);
    expect(
      state(database)
        .filter((row) => row.close_reason === 'revoked')
        .map((row) => row.id_hash),
    ).toStrictEqual(['s1', 's3']);
    expect(closeSessions(database, { clientId: 'c1' }, 'revoked', 8)).toBe(0);
  });
});

describe('countOpenSessions', () => {
  it('ACT-5 counts the open sessions of one target only', () => {
    const database = seeded();
    expect(countOpenSessions(database, 't1')).toBe(2);
    expect(countOpenSessions(database, 't2')).toBe(1);
    expect(countOpenSessions(database, 'none')).toBe(0);
    closeSessions(database, { targetId: 't1' }, 'operator', 9);
    expect(countOpenSessions(database, 't1')).toBe(0);
  });
});
