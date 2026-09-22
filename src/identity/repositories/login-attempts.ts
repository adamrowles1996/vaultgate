import { run } from '../../storage/query.ts';

import { countRows } from './count.ts';

import type { DatabaseSync } from 'node:sqlite';

export interface LoginAttemptsStore {
  record(subject: string, attemptedAt: number, didSucceed: boolean): void;
  countFailuresSince(subject: string, since: number): number;
}

export function createLoginAttemptsStore(database: DatabaseSync): LoginAttemptsStore {
  return {
    record: (subject, attemptedAt, didSucceed) => {
      const sql = 'INSERT INTO login_attempts (subject, attempted_at, succeeded) VALUES (?, ?, ?)';
      run(database, sql, subject, attemptedAt, didSucceed ? 1 : 0);
    },
    countFailuresSince: (subject, since) => {
      const sql =
        'SELECT COUNT(*) AS n FROM login_attempts WHERE subject = ? AND succeeded = 0 AND attempted_at > ?';
      return countRows(database, sql, subject, since);
    },
  };
}
