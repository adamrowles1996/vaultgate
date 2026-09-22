import { z } from 'zod';

import { get, run } from '../../storage/query.ts';

import type { DatabaseSync } from 'node:sqlite';

export interface BootstrapTokensStore {
  insert(tokenHash: string, expiresAt: number): void;
  /**
  True when the hash exists, has not expired and has not been consumed.
  */
  isUsable(tokenHash: string, now: number): boolean;
  /**
  Consumes the token if it is usable; reports whether that happened.
  */
  consume(tokenHash: string, now: number): boolean;
}

const USABLE = 'token_hash = ? AND expires_at > ? AND consumed_at IS NULL';

export function createBootstrapTokensStore(database: DatabaseSync): BootstrapTokensStore {
  const oneSchema = z.object({ one: z.number().int() });
  return {
    insert: (tokenHash, expiresAt) => {
      const sql = 'INSERT INTO bootstrap_tokens (token_hash, expires_at) VALUES (?, ?)';
      run(database, sql, tokenHash, expiresAt);
    },
    isUsable: (tokenHash, now) => {
      const sql = `SELECT 1 AS one FROM bootstrap_tokens WHERE ${USABLE}`;
      return get(database, sql, oneSchema, tokenHash, now) !== undefined;
    },
    consume: (tokenHash, now) => {
      const sql = `UPDATE bootstrap_tokens SET consumed_at = ? WHERE ${USABLE}`;
      return run(database, sql, now, tokenHash, now) === 1;
    },
  };
}
