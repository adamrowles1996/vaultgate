import { z } from 'zod';

import { get, run } from '../../storage/query.ts';

import { jsonObject, optionalText, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const cacheRow = z.object({
  client_id: z.string(),
  document: jsonObject,
  fetched_at: timestamp,
  expires_at: timestamp,
  etag: optionalText,
});

interface CimdCacheEntry {
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

export function createCimdCacheRepo(database: DatabaseSync): CimdCacheRepo {
  return {
    find(clientId) {
      const row = get(database, 'SELECT * FROM cimd_cache WHERE client_id = ?', cacheRow, clientId);
      return row === undefined
        ? undefined
        : {
            clientId: row.client_id,
            document: row.document,
            fetchedAt: row.fetched_at,
            expiresAt: row.expires_at,
            etag: row.etag,
          };
    },
    put(entry) {
      run(
        database,
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
