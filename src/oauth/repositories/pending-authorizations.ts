import { z } from 'zod';

import { get, run } from '../../storage/query.ts';

import { jsonStringRecord, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const pendingRow = z.object({
  id: z.string(),
  session_binding_hash: z.string(),
  parameters: jsonStringRecord,
  expires_at: timestamp,
});

export interface PendingAuthorizationRecord {
  readonly id: string;
  readonly sessionBindingHash: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

export interface PendingAuthorizationsRepo {
  insert(record: PendingAuthorizationRecord): void;
  find(id: string): PendingAuthorizationRecord | undefined;
  delete(id: string): void;
}

export function createPendingAuthorizationsRepo(database: DatabaseSync): PendingAuthorizationsRepo {
  return {
    insert(record) {
      run(
        database,
        `INSERT INTO pending_authorizations (id, session_binding_hash, parameters, expires_at)
         VALUES (?, ?, ?, ?)`,
        record.id,
        record.sessionBindingHash,
        JSON.stringify(record.parameters),
        record.expiresAt,
      );
    },
    find(id) {
      const row = get(
        database,
        'SELECT * FROM pending_authorizations WHERE id = ?',
        pendingRow,
        id,
      );
      return row === undefined
        ? undefined
        : {
            id: row.id,
            sessionBindingHash: row.session_binding_hash,
            parameters: row.parameters,
            expiresAt: row.expires_at,
          };
    },
    delete(id) {
      run(database, 'DELETE FROM pending_authorizations WHERE id = ?', id);
    },
  };
}
