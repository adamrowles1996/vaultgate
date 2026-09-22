import {
  optionalNumber,
  optionalString,
  parseJsonArray,
  type Row,
  type SqlStore,
} from './sql-store.ts';

export type ClientMode = 'cimd' | 'dcr' | 'preregistered';

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
  Inserts or refreshes the name, redirect URIs and metadata of a client.
  */
  upsert(record: ClientRecord): void;
}

function toRecord(row: Row): ClientRecord {
  return {
    id: String(row['id']),
    clientId: String(row['client_id']),
    mode: String(row['mode']) as ClientMode,
    clientName: optionalString(row['client_name']),
    redirectUris: parseJsonArray(row['redirect_uris']),
    metadata: JSON.parse(String(row['metadata'])) as Record<string, unknown>,
    createdAt: Number(row['created_at']),
    revokedAt: optionalNumber(row['revoked_at']),
  };
}

export function createClientsRepo(store: SqlStore): ClientsRepo {
  return {
    findByClientId(clientId) {
      const row = store.get('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
      return row === undefined ? undefined : toRecord(row);
    },
    upsert(record) {
      store.run(
        `INSERT INTO oauth_clients (id, client_id, mode, client_name, redirect_uris, metadata, created_at, revoked_at)
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
