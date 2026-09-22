import { run, transaction } from './query.ts';

import type { Logger } from '../logger.ts';
import type { DatabaseSync } from 'node:sqlite';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOKEN_GRACE_DAYS = 7;
const LOGIN_ATTEMPT_RETENTION_HOURS = 24;

export interface MaintenanceOptions {
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly clock: () => Date;
}

/**
Rows deleted per table by one maintenance run, keyed by table name.
*/
export interface MaintenanceCounts {
  readonly authorization_codes: number;
  readonly sessions: number;
  readonly bootstrap_tokens: number;
  readonly tokens: number;
  readonly login_attempts: number;
  readonly cimd_cache: number;
  readonly pending_authorizations: number;
  readonly audit_events: number;
}

interface Rule {
  readonly table: keyof MaintenanceCounts;
  readonly sql: string;
  readonly cutoff: (now: number, retentionDays: number) => number;
}

/**
 * What STORE-6 lists, and nothing else. "Expired" means the expiry instant
 * has been reached (`<=`); "older than" is strict (`<`). `?1` binds the one
 * cutoff wherever it appears.
 */
const RULES: readonly Rule[] = [
  {
    table: 'authorization_codes',
    sql: 'DELETE FROM authorization_codes WHERE expires_at <= ?1',
    cutoff: (now) => now,
  },
  { table: 'sessions', sql: 'DELETE FROM sessions WHERE expires_at <= ?1', cutoff: (now) => now },
  {
    table: 'bootstrap_tokens',
    sql: 'DELETE FROM bootstrap_tokens WHERE expires_at <= ?1',
    cutoff: (now) => now,
  },
  {
    table: 'tokens',
    sql: 'DELETE FROM tokens WHERE revoked_at <= ?1 OR expires_at <= ?1',
    cutoff: (now) => now - TOKEN_GRACE_DAYS * DAY_MS,
  },
  {
    table: 'login_attempts',
    sql: 'DELETE FROM login_attempts WHERE attempted_at < ?1',
    cutoff: (now) => now - LOGIN_ATTEMPT_RETENTION_HOURS * HOUR_MS,
  },
  {
    table: 'cimd_cache',
    sql: 'DELETE FROM cimd_cache WHERE expires_at <= ?1',
    cutoff: (now) => now,
  },
  {
    table: 'pending_authorizations',
    sql: 'DELETE FROM pending_authorizations WHERE expires_at <= ?1',
    cutoff: (now) => now,
  },
  {
    table: 'audit_events',
    sql: 'DELETE FROM audit_events WHERE at < ?1',
    cutoff: (now, retentionDays) => now - retentionDays * DAY_MS,
  },
];

/**
Deletes every row STORE-6 calls expired as of `now`, in one transaction, and reports the counts.
*/
export function runMaintenance(
  database: DatabaseSync,
  now: Date,
  retentionDays: number,
): MaintenanceCounts {
  const counts: Record<keyof MaintenanceCounts, number> = {
    authorization_codes: 0,
    sessions: 0,
    bootstrap_tokens: 0,
    tokens: 0,
    login_attempts: 0,
    cimd_cache: 0,
    pending_authorizations: 0,
    audit_events: 0,
  };
  transaction(database, () => {
    for (const rule of RULES) {
      counts[rule.table] = run(database, rule.sql, rule.cutoff(now.getTime(), retentionDays));
    }
  });
  return counts;
}

/**
 * Runs maintenance now and then every `intervalMs` on a timer that does not
 * keep the process alive. Every run logs its counts; a failing run is logged
 * and the schedule continues. Returns the function that stops the schedule.
 */
export function startMaintenance(
  database: DatabaseSync,
  logger: Logger,
  { intervalMs, retentionDays, clock }: MaintenanceOptions,
): () => void {
  const tick = (): void => {
    try {
      const counts = runMaintenance(database, clock(), retentionDays);
      logger.info({ counts }, 'store maintenance completed');
    } catch (error) {
      logger.error({ err: error }, 'store maintenance failed');
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
