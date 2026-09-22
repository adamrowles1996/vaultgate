import {
  optionalNumber,
  optionalString,
  parseJsonArray,
  type Row,
  type SqlStore,
} from './sql-store.ts';

export interface ConsentRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly grantedAt: number;
  readonly revokedAt: number | undefined;
}

export interface ConnectedClient extends ConsentRecord {
  readonly clientName: string | undefined;
  readonly lastUsedAt: number | undefined;
}

export interface ConsentsRepo {
  findById(id: string): ConsentRecord | undefined;
  findActive(operatorId: string, clientId: string): ConsentRecord | undefined;
  insert(record: ConsentRecord): void;
  /**
  Returns the number of consents revoked (0 when already revoked or unknown).
  */
  revoke(id: string, at: number): number;
  /**
  OAUTH-30: the operator's connected clients with their last-used time.
  */
  listConnected(operatorId: string): readonly ConnectedClient[];
}

function toRecord(row: Row): ConsentRecord {
  return {
    id: String(row['id']),
    operatorId: String(row['operator_id']),
    clientId: String(row['client_id']),
    scopes: parseJsonArray(row['scopes']),
    grantedAt: Number(row['granted_at']),
    revokedAt: optionalNumber(row['revoked_at']),
  };
}

export function createConsentsRepo(store: SqlStore): ConsentsRepo {
  return {
    findById(id) {
      const row = store.get('SELECT * FROM consents WHERE id = ?', id);
      return row === undefined ? undefined : toRecord(row);
    },
    findActive(operatorId, clientId) {
      const row = store.get(
        `SELECT * FROM consents WHERE operator_id = ? AND client_id = ? AND revoked_at IS NULL
         ORDER BY granted_at DESC LIMIT 1`,
        operatorId,
        clientId,
      );
      return row === undefined ? undefined : toRecord(row);
    },
    insert(record) {
      store.run(
        `INSERT INTO consents (id, operator_id, client_id, scopes, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        record.id,
        record.operatorId,
        record.clientId,
        JSON.stringify(record.scopes),
        record.grantedAt,
        record.revokedAt ?? null,
      );
    },
    revoke(id, at) {
      return store.run(
        'UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
        at,
        id,
      );
    },
    listConnected(operatorId) {
      const rows = store.all(
        `SELECT c.*, k.client_name,
                (SELECT MAX(t.last_used_at) FROM tokens t WHERE t.consent_id = c.id) AS last_used_at
         FROM consents c JOIN oauth_clients k ON k.client_id = c.client_id
         WHERE c.operator_id = ? AND c.revoked_at IS NULL
         ORDER BY c.granted_at DESC`,
        operatorId,
      );
      return rows.map((row) => ({
        ...toRecord(row),
        clientName: optionalString(row['client_name']),
        lastUsedAt: optionalNumber(row['last_used_at']),
      }));
    },
  };
}
