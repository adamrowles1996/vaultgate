import { z } from 'zod';

import { all, get, run } from '../../storage/query.ts';

import { countRows } from './count.ts';

import type { DatabaseSync } from 'node:sqlite';

const rowSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  password_hash: z.string(),
  totp_secret_ciphertext: z.string().nullable(),
  totp_last_step: z.number().int().nullable(),
  created_at: z.number().int(),
  password_changed_at: z.number().int(),
});

export interface OperatorRecord {
  readonly id: string;
  /**
  Lower-cased (ID-3); `undefined` only for an account older than the `operator-email` migration (ID-26).
  */
  readonly email: string | undefined;
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
  /**
  Case-insensitive; pass the address as `normaliseEmail` returns it.
  */
  findByEmail(email: string): OperatorRecord | undefined;
  create(record: OperatorRecord): void;
  updateEmail(id: string, email: string): void;
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
    email: row.email ?? undefined,
    passwordHash: row.password_hash,
    totpSecretCiphertext: row.totp_secret_ciphertext ?? undefined,
    totpLastStep: row.totp_last_step ?? undefined,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
  };
}

const COLUMNS =
  'id, email, password_hash, totp_secret_ciphertext, totp_last_step, created_at, password_changed_at';

/**
`display_name` is deprecated (migration `operator-email`) but still NOT NULL; new rows write `''`.
*/
const INSERT = `INSERT INTO operators (${COLUMNS}, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, '')`;

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
    findByEmail: (email) => {
      const sql = `SELECT ${COLUMNS} FROM operators WHERE lower(email) = lower(?)`;
      const row = get(database, sql, rowSchema, email);
      return row === undefined ? undefined : toRecord(row);
    },
    create: (record) => {
      run(
        database,
        INSERT,
        record.id,
        record.email ?? null,
        record.passwordHash,
        record.totpSecretCiphertext ?? null,
        record.totpLastStep ?? null,
        record.createdAt,
        record.passwordChangedAt,
      );
    },
    updateEmail: (id, email) => {
      run(database, 'UPDATE operators SET email = ? WHERE id = ?', email, id);
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
