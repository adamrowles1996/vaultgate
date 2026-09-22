import { optionalString, type Row, type SqlStore } from './sql-store.ts';

export interface CimdCacheEntry {
  readonly clientId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly etag: string | undefined;
}

export interface CimdCacheRepo {
  find(clientId: string): CimdCacheEntry | undefined;
  put(entry: CimdCacheEntry): void;
}

function toEntry(row: Row): CimdCacheEntry {
  return {
    clientId: String(row['client_id']),
    document: JSON.parse(String(row['document'])) as Record<string, unknown>,
    fetchedAt: Number(row['fetched_at']),
    expiresAt: Number(row['expires_at']),
    etag: optionalString(row['etag']),
  };
}

export function createCimdCacheRepo(store: SqlStore): CimdCacheRepo {
  return {
    find(clientId) {
      const row = store.get('SELECT * FROM cimd_cache WHERE client_id = ?', clientId);
      return row === undefined ? undefined : toEntry(row);
    },
    put(entry) {
      store.run(
        `INSERT INTO cimd_cache (client_id, document, fetched_at, expires_at, etag)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET
           document = excluded.document,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           etag = excluded.etag`,
        entry.clientId,
        JSON.stringify(entry.document),
        entry.fetchedAt,
        entry.expiresAt,
        entry.etag ?? null,
      );
    },
  };
}
