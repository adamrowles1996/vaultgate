import { z } from 'zod';

import { all, get, run } from '../../storage/query.ts';

import { jsonStringArray, optionalText, optionalTimestamp, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const consentRow = z.object({
  id: z.string(),
  operator_id: z.string(),
  client_id: z.string(),
  scopes: jsonStringArray,
  granted_at: timestamp,
  revoked_at: optionalTimestamp,
});

const connectedRow = consentRow.extend({
  client_name: optionalText,
  last_used_at: optionalTimestamp,
});

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
  Widens an active consent to the scopes the operator has now approved.
  */
  updateScopes(id: string, scopes: readonly string[]): void;
  /**
  Returns the number of consents revoked: 0 when already revoked or unknown.
  */
  revoke(id: string, at: number): number;
  /**
  OAUTH-30: the operator's connected clients with their last-used time.
  */
  listConnected(operatorId: string): readonly ConnectedClient[];
}

function toRecord(row: z.output<typeof consentRow>): ConsentRecord {
  return {
    id: row.id,
    operatorId: row.operator_id,
    clientId: row.client_id,
    scopes: row.scopes,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  };
}

export function createConsentsRepo(database: DatabaseSync): ConsentsRepo {
  return {
    findById(id) {
      const row = get(database, 'SELECT * FROM consents WHERE id = ?', consentRow, id);
      return row === undefined ? undefined : toRecord(row);
    },
    findActive(operatorId, clientId) {
      const row = get(
        database,
        `SELECT * FROM consents WHERE operator_id = ? AND client_id = ? AND revoked_at IS NULL
         ORDER BY granted_at DESC LIMIT 1`,
        consentRow,
        operatorId,
        clientId,
      );
      return row === undefined ? undefined : toRecord(row);
    },
    insert(record) {
      run(
        database,
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
    updateScopes(id, scopes) {
      run(database, 'UPDATE consents SET scopes = ? WHERE id = ?', JSON.stringify(scopes), id);
    },
    revoke(id, at) {
      return run(
        database,
        'UPDATE consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
        at,
        id,
      );
    },
    listConnected(operatorId) {
      return all(
        database,
        `SELECT c.*, k.client_name,
                (SELECT MAX(t.last_used_at) FROM tokens t WHERE t.consent_id = c.id) AS last_used_at
         FROM consents c JOIN oauth_clients k ON k.client_id = c.client_id
         WHERE c.operator_id = ? AND c.revoked_at IS NULL
         ORDER BY c.granted_at DESC`,
        connectedRow,
        operatorId,
      ).map((row) => ({
        ...toRecord(row),
        clientName: row.client_name,
        lastUsedAt: row.last_used_at,
      }));
    },
  };
}
