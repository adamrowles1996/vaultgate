import { z } from 'zod';

import { get, run } from '../../storage/query.ts';

import { jsonObject, jsonStringArray, optionalText, optionalTimestamp, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const clientRow = z.object({
  id: z.string(),
  client_id: z.string(),
  mode: z.enum(['cimd', 'dcr', 'preregistered']),
  client_name: optionalText,
  redirect_uris: jsonStringArray,
  metadata: jsonObject,
  created_at: timestamp,
  revoked_at: optionalTimestamp,
});

export type ClientMode = z.output<typeof clientRow>['mode'];

export interface ClientRecord {
  readonly id: string;
  readonly clientId: string;
  readonly mode: ClientMode;
  readonly clientName: string | undefined;
  readonly redirectUris: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly revokedAt: number | undefined;
}

export interface ClientsRepo {
  findByClientId(clientId: string): ClientRecord | undefined;
  /**
  Inserts a client, or refreshes the name, redirect URIs and metadata of an existing one.
  */
  upsert(record: ClientRecord): void;
}

function toRecord(row: z.output<typeof clientRow>): ClientRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    mode: row.mode,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    metadata: row.metadata,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function createClientsRepo(database: DatabaseSync): ClientsRepo {
  return {
    findByClientId(clientId) {
      const row = get(
        database,
        'SELECT * FROM oauth_clients WHERE client_id = ?',
        clientRow,
        clientId,
      );
      return row === undefined ? undefined : toRecord(row);
    },
    upsert(record) {
      run(
        database,
        `INSERT INTO oauth_clients
           (id, client_id, mode, client_name, redirect_uris, metadata, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET
           client_name = excluded.client_name,
           redirect_uris = excluded.redirect_uris,
           metadata = excluded.metadata`,
        record.id,
        record.clientId,
        record.mode,
        record.clientName ?? null,
        JSON.stringify(record.redirectUris),
        JSON.stringify(record.metadata),
        record.createdAt,
        record.revokedAt ?? null,
      );
    },
  };
}
