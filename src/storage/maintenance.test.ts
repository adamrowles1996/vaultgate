import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { captureLogger } from '../test-support/logging.ts';
import { unwrapOk } from '../test-support/result.ts';

import { runMaintenance, startMaintenance } from './maintenance.ts';
import { migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { all, run } from './query.ts';

const NOW = new Date('2026-09-22T12:00:00Z');
const T = NOW.getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const RETENTION_DAYS = 30;

const idSchema = z.object({ id: z.string() });

const CODE =
  "INSERT INTO authorization_codes (code_hash, client_id, consent_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?, 'client', 'co', 'u', 'c', '[]', ?)";
const SESSION =
  "INSERT INTO sessions (id_hash, operator_id, created_at, last_seen_at, expires_at, csrf_token) VALUES (?, 'op', 0, 0, ?, 'x')";
const TOKEN =
  "INSERT INTO tokens (id, token_hash, kind, family_id, client_id, consent_id, scopes, issued_at, expires_at, revoked_at) VALUES (?, ?, 'access', 'f', 'client', 'co', '[]', 0, ?, ?)";
const AUDIT =
  "INSERT INTO audit_events (id, at, category, action, outcome) VALUES (?, ?, 'c', 'a', 'ok')";

type Seed = readonly [sql: string, ...values: (string | number | null)[]];

/**
One row per case: `-keep` rows survive, `-drop` rows are what STORE-6 deletes.
*/
const SEEDS: readonly Seed[] = [
  ['INSERT INTO operators VALUES (?, ?, ?, ?, ?, ?, ?)', 'op', 'Op', 'hash', null, null, T, T],
  [
    'INSERT INTO oauth_clients VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'cl',
    'client',
    'dcr',
    'C',
    '[]',
    '{}',
    T,
    null,
  ],
  ['INSERT INTO consents VALUES (?, ?, ?, ?, ?, ?)', 'co', 'op', 'client', '[]', T, null],
  [CODE, 'code-keep', T + 1],
  [CODE, 'code-drop', T],
  [SESSION, 'session-keep', T + 1],
  [SESSION, 'session-drop', T],
  ['INSERT INTO bootstrap_tokens VALUES (?, ?, ?)', 'boot-keep', T + 1, null],
  ['INSERT INTO bootstrap_tokens VALUES (?, ?, ?)', 'boot-drop', T - 1, T - 2],
  [TOKEN, 'tok-keep-live', 'h1', T + HOUR, null],
  [TOKEN, 'tok-keep-expired-recently', 'h2', T - 7 * DAY + 1, null],
  [TOKEN, 'tok-keep-revoked-recently', 'h3', T + DAY, T - 7 * DAY + 1],
  [TOKEN, 'tok-drop-expired', 'h4', T - 7 * DAY, null],
  [TOKEN, 'tok-drop-revoked', 'h5', T + DAY, T - 7 * DAY],
  ['INSERT INTO login_attempts VALUES (?, ?, ?)', 'keep', T - 24 * HOUR, 0],
  ['INSERT INTO login_attempts VALUES (?, ?, ?)', 'drop', T - 24 * HOUR - 1, 1],
  ['INSERT INTO cimd_cache VALUES (?, ?, ?, ?, ?)', 'cimd-keep', '{}', T, T + 1, null],
  ['INSERT INTO cimd_cache VALUES (?, ?, ?, ?, ?)', 'cimd-drop', '{}', T, T, 'e'],
  ['INSERT INTO pending_authorizations VALUES (?, ?, ?, ?)', 'pend-keep', 'b', '{}', T + 1],
  ['INSERT INTO pending_authorizations VALUES (?, ?, ?, ?)', 'pend-drop', 'b', '{}', T],
  [AUDIT, 'audit-keep', T - RETENTION_DAYS * DAY],
  [AUDIT, 'audit-drop', T - RETENTION_DAYS * DAY - 1],
];

function seeded(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  unwrapOk(migrate(database, MIGRATIONS, NOW));
  for (const [sql, ...values] of SEEDS) {
    run(database, sql, ...values);
  }
  return database;
}

function remaining(database: DatabaseSync, table: string, column = 'id'): string[] {
  return all(database, `SELECT ${column} AS id FROM ${table} ORDER BY ${column}`, idSchema).map(
    (row) => row.id,
  );
}

describe('runMaintenance', () => {
  it('STORE-6 deletes exactly the expired rows and reports the counts', () => {
    const database = seeded();
    expect(runMaintenance(database, NOW, RETENTION_DAYS)).toStrictEqual({
      authorization_codes: 1,
      sessions: 1,
      bootstrap_tokens: 1,
      tokens: 2,
      login_attempts: 1,
      cimd_cache: 1,
      pending_authorizations: 1,
      audit_events: 1,
    });
    expect(remaining(database, 'authorization_codes', 'code_hash')).toStrictEqual(['code-keep']);
    expect(remaining(database, 'sessions', 'id_hash')).toStrictEqual(['session-keep']);
    expect(remaining(database, 'bootstrap_tokens', 'token_hash')).toStrictEqual(['boot-keep']);
    expect(remaining(database, 'tokens')).toStrictEqual([
      'tok-keep-expired-recently',
      'tok-keep-live',
      'tok-keep-revoked-recently',
    ]);
    expect(remaining(database, 'login_attempts', 'subject')).toStrictEqual(['keep']);
    expect(remaining(database, 'cimd_cache', 'client_id')).toStrictEqual(['cimd-keep']);
    expect(remaining(database, 'pending_authorizations')).toStrictEqual(['pend-keep']);
    expect(remaining(database, 'audit_events')).toStrictEqual(['audit-keep']);
    expect(remaining(database, 'operators')).toStrictEqual(['op']);
    expect(remaining(database, 'oauth_clients')).toStrictEqual(['cl']);
    expect(remaining(database, 'consents')).toStrictEqual(['co']);
  });

  it('STORE-6 reports zero counts on a clean database', () => {
    const database = seeded();
    runMaintenance(database, NOW, RETENTION_DAYS);
    expect(Object.values(runMaintenance(database, NOW, RETENTION_DAYS))).toStrictEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});

describe('startMaintenance', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('STORE-6 runs at once, then on every interval, and logs each run', () => {
    vi.useFakeTimers({ now: NOW });
    const database = seeded();
    const { logger, lines } = captureLogger();
    const stop = startMaintenance(database, logger, {
      intervalMs: HOUR,
      retentionDays: RETENTION_DAYS,
      clock: () => new Date(),
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      msg: 'store maintenance completed',
      counts: { tokens: 2, audit_events: 1 },
    });
    run(
      database,
      'INSERT INTO pending_authorizations VALUES (?, ?, ?, ?)',
      'later',
      'b',
      '{}',
      T + HOUR,
    );
    vi.advanceTimersByTime(HOUR - 1);
    expect(lines()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toMatchObject({ counts: { pending_authorizations: 2 } });
    expect(remaining(database, 'pending_authorizations')).toStrictEqual([]);
    stop();
    vi.advanceTimersByTime(HOUR);
    expect(lines()).toHaveLength(2);
  });

  it('STORE-6 logs a failing run and keeps the schedule', () => {
    vi.useFakeTimers({ now: NOW });
    const database = seeded();
    const { logger, lines } = captureLogger();
    database.exec('DROP TABLE audit_events');
    const stop = startMaintenance(database, logger, {
      intervalMs: HOUR,
      retentionDays: RETENTION_DAYS,
      clock: () => NOW,
    });
    vi.advanceTimersByTime(HOUR);
    stop();
    const messages = lines().map((line) => line['msg']);
    expect(messages).toStrictEqual(['store maintenance failed', 'store maintenance failed']);
    expect(lines()[0]).toMatchObject({ err: { message: 'no such table: audit_events' } });
    expect(database.isTransaction).toBe(false);
    expect(remaining(database, 'sessions', 'id_hash')).toStrictEqual([
      'session-drop',
      'session-keep',
    ]);
  });
});
