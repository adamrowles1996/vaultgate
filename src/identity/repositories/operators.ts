import { z } from 'zod';

import { all, get, run } from '../../storage/query.ts';

import { countRows } from './count.ts';

import type { DatabaseSync } from 'node:sqlite';

const rowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  password_hash: z.string(),
  totp_secret_ciphertext: z.string().nullable(),
  totp_last_step: z.number().int().nullable(),
  created_at: z.number().int(),
  password_changed_at: z.number().int(),
});

export interface OperatorRecord {
  readonly id: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly totpSecretCiphertext: string | undefined;
  readonly totpLastStep: number | undefined;
  readonly createdAt: number;
  readonly passwordChangedAt: number;
}

export interface OperatorsStore {
  count(): number;
  /**
  The operator account; v1 has exactly one once setup completes.
  */
  findAny(): OperatorRecord | undefined;
  findById(id: string): OperatorRecord | undefined;
  findByDisplayName(displayName: string): OperatorRecord | undefined;
  create(record: OperatorRecord): void;
  updatePasswordHash(id: string, passwordHash: string, changedAt: number): void;
  /**
  Stores a new TOTP secret and clears the replay marker.
  */
  updateTotpSecret(id: string, ciphertext: string): void;
  updateTotpLastStep(id: string, step: number): void;
}

function toRecord(row: z.output<typeof rowSchema>): OperatorRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    totpSecretCiphertext: row.totp_secret_ciphertext ?? undefined,
    totpLastStep: row.totp_last_step ?? undefined,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
  };
}

const COLUMNS =
  'id, display_name, password_hash, totp_secret_ciphertext, totp_last_step, created_at, password_changed_at';

export function createOperatorsStore(database: DatabaseSync): OperatorsStore {
  return {
    count: () => countRows(database, 'SELECT COUNT(*) AS n FROM operators'),
    findAny: () =>
      all(database, `SELECT ${COLUMNS} FROM operators ORDER BY created_at LIMIT 1`, rowSchema).map(
        (row) => toRecord(row),
      )[0],
    findById: (id) => {
      const row = get(database, `SELECT ${COLUMNS} FROM operators WHERE id = ?`, rowSchema, id);
      return row === undefined ? undefined : toRecord(row);
    },
    findByDisplayName: (displayName) => {
      const sql = `SELECT ${COLUMNS} FROM operators WHERE display_name = ?`;
      const row = get(database, sql, rowSchema, displayName);
      return row === undefined ? undefined : toRecord(row);
    },
    create: (record) => {
      run(
        database,
        `INSERT INTO operators (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.displayName,
        record.passwordHash,
        record.totpSecretCiphertext ?? null,
        record.totpLastStep ?? null,
        record.createdAt,
        record.passwordChangedAt,
      );
    },
    updatePasswordHash: (id, passwordHash, changedAt) => {
      const sql = 'UPDATE operators SET password_hash = ?, password_changed_at = ? WHERE id = ?';
      run(database, sql, passwordHash, changedAt, id);
    },
    updateTotpSecret: (id, ciphertext) => {
      const sql =
        'UPDATE operators SET totp_secret_ciphertext = ?, totp_last_step = NULL WHERE id = ?';
      run(database, sql, ciphertext, id);
    },
    updateTotpLastStep: (id, step) => {
      run(database, 'UPDATE operators SET totp_last_step = ? WHERE id = ?', step, id);
    },
  };
}
