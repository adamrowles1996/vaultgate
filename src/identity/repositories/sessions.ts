import { z } from 'zod';

import { all, get, run } from '../../storage/query.ts';

import type { DatabaseSync } from 'node:sqlite';

const rowSchema = z.object({
  id_hash: z.string(),
  operator_id: z.string(),
  created_at: z.number().int(),
  last_seen_at: z.number().int(),
  expires_at: z.number().int(),
  reauthenticated_at: z.number().int().nullable(),
  csrf_token: z.string(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
});

export interface SessionRecord {
  readonly idHash: string;
  readonly operatorId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly reauthenticatedAt: number | undefined;
  readonly csrfToken: string;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

export interface SessionsStore {
  insert(record: SessionRecord): void;
  findByIdHash(idHash: string): SessionRecord | undefined;
  listForOperator(operatorId: string): readonly SessionRecord[];
  touch(idHash: string, lastSeenAt: number, expiresAt: number): void;
  setReauthenticatedAt(idHash: string, at: number): void;
  delete(idHash: string): void;
  /**
  Ends every other session of the operator (password change, ID-15 / OPS incident table).
  */
  deleteOthersForOperator(operatorId: string, keepIdHash: string): number;
}

function toRecord(row: z.output<typeof rowSchema>): SessionRecord {
  return {
    idHash: row.id_hash,
    operatorId: row.operator_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    reauthenticatedAt: row.reauthenticated_at ?? undefined,
    csrfToken: row.csrf_token,
    ip: row.ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
  };
}

const COLUMNS =
  'id_hash, operator_id, created_at, last_seen_at, expires_at, reauthenticated_at, csrf_token, ip, user_agent';

export function createSessionsStore(database: DatabaseSync): SessionsStore {
  return {
    insert: (record) => {
      run(
        database,
        `INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.idHash,
        record.operatorId,
        record.createdAt,
        record.lastSeenAt,
        record.expiresAt,
        record.reauthenticatedAt ?? null,
        record.csrfToken,
        record.ip ?? null,
        record.userAgent ?? null,
      );
    },
    findByIdHash: (idHash) => {
      const row = get(
        database,
        `SELECT ${COLUMNS} FROM sessions WHERE id_hash = ?`,
        rowSchema,
        idHash,
      );
      return row === undefined ? undefined : toRecord(row);
    },
    listForOperator: (operatorId) => {
      const sql = `SELECT ${COLUMNS} FROM sessions WHERE operator_id = ? ORDER BY created_at`;
      return all(database, sql, rowSchema, operatorId).map((row) => toRecord(row));
    },
    touch: (idHash, lastSeenAt, expiresAt) => {
      const sql = 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?';
      run(database, sql, lastSeenAt, expiresAt, idHash);
    },
    setReauthenticatedAt: (idHash, at) => {
      run(database, 'UPDATE sessions SET reauthenticated_at = ? WHERE id_hash = ?', at, idHash);
    },
    delete: (idHash) => {
      run(database, 'DELETE FROM sessions WHERE id_hash = ?', idHash);
    },
    deleteOthersForOperator: (operatorId, keepIdHash) =>
      run(
        database,
        'DELETE FROM sessions WHERE operator_id = ? AND id_hash <> ?',
        operatorId,
        keepIdHash,
      ),
  };
}
