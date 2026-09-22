import type { SqlStore } from './sql-store.ts';

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

export function createPendingAuthorizationsRepo(store: SqlStore): PendingAuthorizationsRepo {
  return {
    insert(record) {
      store.run(
        `INSERT INTO pending_authorizations (id, session_binding_hash, parameters, expires_at)
         VALUES (?, ?, ?, ?)`,
        record.id,
        record.sessionBindingHash,
        JSON.stringify(record.parameters),
        record.expiresAt,
      );
    },
    find(id) {
      const row = store.get('SELECT * FROM pending_authorizations WHERE id = ?', id);
      return row === undefined
        ? undefined
        : {
            id: String(row['id']),
            sessionBindingHash: String(row['session_binding_hash']),
            parameters: JSON.parse(String(row['parameters'])) as Record<string, string>,
            expiresAt: Number(row['expires_at']),
          };
    },
    delete(id) {
      store.run('DELETE FROM pending_authorizations WHERE id = ?', id);
    },
  };
}
