import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IN_MEMORY, openDatabase } from './database.ts';
import { get } from './query.ts';

import type { DatabaseSync } from 'node:sqlite';

const nameSchema = z.object({ name: z.string() });

const created: string[] = [];

function scratchPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vaultgate-database-'));
  created.push(directory);
  return join(directory, 'nested', 'vaultgate.sqlite');
}

function pragma(database: DatabaseSync, name: string): unknown {
  return Object.values(database.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

describe('openDatabase', () => {
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('STORE-1 creates the parent directory and the file with mode 0600', () => {
    const path = scratchPath();
    const database = openDatabase({ path, networkFs: false });
    expect(database.isOpen).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    database.close();
  });

  it('STORE-1 reopens an existing database and keeps it private', () => {
    const path = scratchPath();
    const first = openDatabase({ path, networkFs: false });
    first.exec('CREATE TABLE kept (id INTEGER)');
    first.close();
    const second = openDatabase({ path, networkFs: false });
    expect(
      get(second, "SELECT name FROM sqlite_master WHERE name = 'kept'", nameSchema),
    ).toStrictEqual({ name: 'kept' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    second.close();
  });

  it('STORE-1 supports an in-memory database without touching the file system', () => {
    const database = openDatabase({ path: IN_MEMORY, networkFs: false });
    expect(database.isOpen).toBe(true);
    expect(existsSync(IN_MEMORY)).toBe(false);
    database.close();
  });

  it('STORE-2 applies the local-disk pragmas', () => {
    const database = openDatabase({ path: scratchPath(), networkFs: false });
    expect(pragma(database, 'journal_mode')).toBe('wal');
    expect(pragma(database, 'synchronous')).toBe(1);
    expect(pragma(database, 'foreign_keys')).toBe(1);
    expect(pragma(database, 'busy_timeout')).toBe(5000);
    expect(pragma(database, 'locking_mode')).toBe('normal');
    database.close();
  });

  it('STORE-2 applies the network-filesystem pragmas', () => {
    const database = openDatabase({ path: scratchPath(), networkFs: true });
    expect(pragma(database, 'journal_mode')).toBe('truncate');
    expect(pragma(database, 'synchronous')).toBe(2);
    expect(pragma(database, 'locking_mode')).toBe('exclusive');
    expect(pragma(database, 'foreign_keys')).toBe(1);
    expect(pragma(database, 'busy_timeout')).toBe(5000);
    database.close();
  });
});
