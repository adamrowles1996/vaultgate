import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { captureLogger } from '../test-support/logging.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { MigrationError, openStore, StoreOpenError } from './index.ts';
import { all } from './query.ts';

const NOW = new Date('2026-09-22T12:00:00Z');
const versionSchema = z.object({ version: z.number() });
const created: string[] = [];

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vaultgate-store-'));
  created.push(directory);
  return directory;
}

function storeConfig(dataDirectory: string): Parameters<typeof openStore>[0] {
  return { dataDir: dataDirectory, sqliteNetworkFs: false, auditRetentionDays: 30 };
}

describe('openStore', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens, migrates and starts maintenance under the data directory', () => {
    vi.useFakeTimers({ now: NOW });
    const dataDirectory = join(scratchDirectory(), 'data');
    const config = storeConfig(dataDirectory);
    const { logger, lines } = captureLogger();
    const store = unwrapOk(openStore(config, logger, () => NOW));
    expect(existsSync(join(dataDirectory, 'vaultgate.sqlite'))).toBe(true);
    expect(all(store.db, 'SELECT version FROM schema_migrations', versionSchema)).toStrictEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(lines().map((line) => line['msg'])).toStrictEqual([
      'store ready',
      'store maintenance completed',
    ]);
    expect(lines()[0]).toMatchObject({
      path: join(dataDirectory, 'vaultgate.sqlite'),
      applied: [1, 2, 3, 4, 5],
      version: 5,
    });
    vi.advanceTimersByTime(3_600_000);
    expect(lines()).toHaveLength(3);
    store.close();
    expect(store.db.isOpen).toBe(false);
    vi.advanceTimersByTime(3_600_000);
    expect(lines()).toHaveLength(3);
  });

  it('uses the wall clock when no clock is injected', () => {
    const before = Date.now();
    const config = storeConfig(scratchDirectory());
    const store = unwrapOk(openStore(config, captureLogger().logger));
    const [row] = all(
      store.db,
      'SELECT applied_at FROM schema_migrations',
      z.object({ applied_at: z.number() }),
    );
    expect(row?.applied_at).toBeGreaterThanOrEqual(before);
    expect(row?.applied_at).toBeLessThanOrEqual(Date.now());
    store.close();
  });

  it('fails without opening anything when the data directory cannot be created', () => {
    const blocker = join(scratchDirectory(), 'file');
    writeFileSync(blocker, '');
    const config = storeConfig(blocker);
    const error = unwrapFail(openStore(config, captureLogger().logger, () => NOW));
    expect(error).toBeInstanceOf(StoreOpenError);
    expect(error.name).toBe('StoreOpenError');
    expect(error.message).toBe(`cannot open the database at ${join(blocker, 'vaultgate.sqlite')}`);
    expect(error.cause).toMatchObject({ code: 'EEXIST' });
  });

  it('OPS-8 closes the database and fails when migrations refuse the database', () => {
    const dataDirectory = scratchDirectory();
    const path = join(dataDirectory, 'vaultgate.sqlite');
    const newer = new DatabaseSync(path);
    newer.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, 0, ?), (2, 0, ?)'.replaceAll(
        '?',
        "'x'",
      ),
    );
    newer.close();
    const { logger, lines } = captureLogger();
    const config = storeConfig(dataDirectory);
    const error = unwrapFail(openStore(config, logger, () => NOW));
    expect(error).toBeInstanceOf(MigrationError);
    expect(lines()).toStrictEqual([]);
    const reopened = new DatabaseSync(path);
    reopened.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT');
    reopened.close();
  });
});
