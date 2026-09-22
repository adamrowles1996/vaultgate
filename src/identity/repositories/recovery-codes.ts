import { run } from '../../storage/query.ts';

import { countRows } from './count.ts';

import type { DatabaseSync } from 'node:sqlite';

export interface RecoveryCodesStore {
  /**
  Replaces every code for the operator with the given hashes (ID-11); callers own the transaction.
  */
  replaceAll(operatorId: string, codeHashes: readonly string[]): void;
  /**
  Marks the code used and reports whether it was unused until now.
  */
  consume(operatorId: string, codeHash: string, usedAt: number): boolean;
  countUnused(operatorId: string): number;
}

export function createRecoveryCodesStore(database: DatabaseSync): RecoveryCodesStore {
  return {
    replaceAll: (operatorId, codeHashes) => {
      run(database, 'DELETE FROM recovery_codes WHERE operator_id = ?', operatorId);
      for (const codeHash of codeHashes) {
        const sql = 'INSERT INTO recovery_codes (code_hash, operator_id) VALUES (?, ?)';
        run(database, sql, codeHash, operatorId);
      }
    },
    consume: (operatorId, codeHash, usedAt) => {
      const sql =
        'UPDATE recovery_codes SET used_at = ? WHERE operator_id = ? AND code_hash = ? AND used_at IS NULL';
      return run(database, sql, usedAt, operatorId, codeHash) === 1;
    },
    countUnused: (operatorId) => {
      const sql =
        'SELECT COUNT(*) AS n FROM recovery_codes WHERE operator_id = ? AND used_at IS NULL';
      return countRows(database, sql, operatorId);
    },
  };
}
