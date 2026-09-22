import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const IN_MEMORY = ':memory:';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface OpenDatabaseOptions {
  readonly path: string;
  /**
  Network-filesystem-safe settings (Azure Files); single replica only (STORE-2).
  */
  readonly networkFs: boolean;
}

/**
Pragmas for a local disk: WAL for concurrent readers, NORMAL sync is durable under WAL.
*/
const LOCAL_PRAGMAS = ['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL'] as const;

/**
Pragmas for SMB/NFS mounts, where WAL's shared memory is unsafe and file locks are unreliable.
*/
const NETWORK_FS_PRAGMAS = [
  'PRAGMA journal_mode = TRUNCATE',
  'PRAGMA synchronous = FULL',
  'PRAGMA locking_mode = EXCLUSIVE',
] as const;

/**
Applied in both modes: referential integrity and a bounded wait on a locked file.
*/
const COMMON_PRAGMAS = ['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000'] as const;

/**
 * Creates the database file (mode 0600, parent directory 0700) before SQLite
 * touches it, so no window exists in which the file is world-readable.
 * SQLite gives the WAL and journal files the same mode as the database.
 */
function ensurePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  closeSync(openSync(path, 'a', FILE_MODE));
  chmodSync(path, FILE_MODE);
}

/**
Opens (creating when absent) the SQLite database with the STORE-1/STORE-2 settings applied.
*/
export function openDatabase({ path, networkFs }: OpenDatabaseOptions): DatabaseSync {
  if (path !== IN_MEMORY) {
    ensurePrivateFile(path);
  }
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  for (const pragma of [...(networkFs ? NETWORK_FS_PRAGMAS : LOCAL_PRAGMAS), ...COMMON_PRAGMAS]) {
    database.exec(pragma);
  }
  return database;
}

/**
 * Opens an existing database read-only, for the audit export CLI running
 * beside (or after) the server. `undefined` when no file exists yet: a store
 * that was never created holds no events, which is not an error.
 */
export function openReadOnlyDatabase(path: string): DatabaseSync | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const database = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}
