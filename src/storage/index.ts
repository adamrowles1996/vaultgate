import { join } from 'node:path';

import { fail, ok, type Result } from '../result.ts';

import { openDatabase } from './database.ts';
import { startMaintenance } from './maintenance.ts';
import { type MigrationError, migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';

import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { DatabaseSync } from 'node:sqlite';

export { MigrationError } from './migrate.ts';

const DATABASE_FILE = 'vaultgate.sqlite';
const MAINTENANCE_INTERVAL_MS = 3_600_000;

export type StoreConfig = Pick<Config, 'dataDir' | 'sqliteNetworkFs' | 'auditRetentionDays'>;

export interface Store {
  readonly db: DatabaseSync;
  /**
  Stops maintenance and closes the connection; the store is unusable afterwards.
  */
  readonly close: () => void;
}

/**
The database could not be opened at all (permissions, a file where a directory should be, …).
*/
export class StoreOpenError extends Error {
  constructor(path: string, cause: unknown) {
    super(`cannot open the database at ${path}`, { cause });
    this.name = 'StoreOpenError';
  }
}

export type StoreError = StoreOpenError | MigrationError;

/**
The database file under the data directory; the one path the server and the CLI share.
*/
export function databasePath(config: Pick<StoreConfig, 'dataDir'>): string {
  return join(config.dataDir, DATABASE_FILE);
}

/**
 * Opens the database under `config.dataDir`, applies pending migrations and
 * starts the hourly maintenance schedule (spec 07). A failure leaves nothing
 * open.
 */
export function openStore(
  config: StoreConfig,
  logger: Logger,
  clock: () => Date = () => new Date(),
): Result<Store, StoreError> {
  const path = databasePath(config);
  let database: DatabaseSync;
  try {
    database = openDatabase({ path, networkFs: config.sqliteNetworkFs });
  } catch (error) {
    return fail(new StoreOpenError(path, error));
  }
  const migrated = migrate(database, MIGRATIONS, clock());
  if (!migrated.ok) {
    database.close();
    return migrated;
  }
  logger.info({ path, ...migrated.value }, 'store ready');
  const stopMaintenance = startMaintenance(database, logger, {
    intervalMs: MAINTENANCE_INTERVAL_MS,
    retentionDays: config.auditRetentionDays,
    clock,
  });
  return ok({
    db: database,
    close: () => {
      stopMaintenance();
      database.close();
    },
  });
}
