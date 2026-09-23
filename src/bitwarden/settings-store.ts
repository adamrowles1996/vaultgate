/**
 * The `vault_settings` row (STORE-9): the connection the operator saved on
 * the account page. Ciphertext in, ciphertext out; `settings.ts` owns the
 * sealing so this module knows nothing about keys.
 */
import { z } from 'zod';

import { get, run } from '../storage/query.ts';

import type { DatabaseSync } from 'node:sqlite';

const ROW_ID = 1;

const rowSchema = z.object({
  server_url: z.string().nullable(),
  client_id: z.string(),
  client_secret_ciphertext: z.string(),
  master_password_ciphertext: z.string(),
  updated_at: z.number().int(),
  updated_by: z.string(),
});

export interface VaultSettingsRecord {
  readonly serverUrl: string | undefined;
  readonly clientId: string;
  readonly clientSecretCiphertext: string;
  readonly masterPasswordCiphertext: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface VaultSettingsStore {
  find(): VaultSettingsRecord | undefined;
  /**
  Inserts or replaces the single row.
  */
  save(record: VaultSettingsRecord): void;
  /**
  Removes the row; a no-op when there is none.
  */
  clear(): void;
}

const COLUMNS =
  'server_url, client_id, client_secret_ciphertext, master_password_ciphertext, updated_at, updated_by';

function toRecord(row: z.output<typeof rowSchema>): VaultSettingsRecord {
  return {
    serverUrl: row.server_url ?? undefined,
    clientId: row.client_id,
    clientSecretCiphertext: row.client_secret_ciphertext,
    masterPasswordCiphertext: row.master_password_ciphertext,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function createVaultSettingsStore(database: DatabaseSync): VaultSettingsStore {
  return {
    find: () => {
      const sql = `SELECT ${COLUMNS} FROM vault_settings WHERE id = ?`;
      const row = get(database, sql, rowSchema, ROW_ID);
      return row === undefined ? undefined : toRecord(row);
    },
    save: (record) => {
      run(
        database,
        `INSERT OR REPLACE INTO vault_settings (id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ROW_ID,
        record.serverUrl ?? null,
        record.clientId,
        record.clientSecretCiphertext,
        record.masterPasswordCiphertext,
        record.updatedAt,
        record.updatedBy,
      );
    },
    clear: () => {
      run(database, 'DELETE FROM vault_settings WHERE id = ?', ROW_ID);
    },
  };
}
