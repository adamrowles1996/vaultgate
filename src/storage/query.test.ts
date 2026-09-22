import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all, get, run, transaction } from './query.ts';

const itemSchema = z.object({ id: z.number(), name: z.string() });

function database(): DatabaseSync {
  const database_ = new DatabaseSync(':memory:');
  database_.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  return database_;
}

describe('run', () => {
  it('executes a statement and reports the rows it changed', () => {
    const database_ = database();
    expect(run(database_, 'INSERT INTO items (id, name) VALUES (?, ?)', 1, 'one')).toBe(1);
    expect(run(database_, 'UPDATE items SET name = ? WHERE id = ?', 'uno', 9)).toBe(0);
  });
});

describe('get', () => {
  it('returns the first row parsed through the schema', () => {
    const database_ = database();
    run(database_, "INSERT INTO items (id, name) VALUES (1, 'one'), (2, 'two')");
    expect(get(database_, 'SELECT id, name FROM items ORDER BY id', itemSchema)).toStrictEqual({
      id: 1,
      name: 'one',
    });
  });

  it('returns undefined when nothing matches', () => {
    expect(get(database(), 'SELECT id, name FROM items WHERE id = ?', itemSchema, 7)).toBe(
      undefined,
    );
  });

  it('rejects a row that does not match the schema', () => {
    const database_ = database();
    run(database_, "INSERT INTO items (id, name) VALUES (1, 'one')");
    expect(() => get(database_, 'SELECT id FROM items', itemSchema)).toThrow(z.ZodError);
  });
});

describe('all', () => {
  it('returns every row parsed through the schema', () => {
    const database_ = database();
    run(database_, "INSERT INTO items (id, name) VALUES (1, 'one'), (2, 'two')");
    expect(all(database_, 'SELECT id, name FROM items WHERE id >= ?', itemSchema, 1)).toStrictEqual(
      [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ],
    );
  });
});

describe('transaction', () => {
  it('commits when the work returns and yields its result', () => {
    const database_ = database();
    const result = transaction(database_, () =>
      run(database_, "INSERT INTO items (id, name) VALUES (1, 'one')"),
    );
    expect(result).toBe(1);
    expect(database_.isTransaction).toBe(false);
    expect(all(database_, 'SELECT id, name FROM items', itemSchema)).toHaveLength(1);
  });

  it('rolls back and rethrows when the work throws', () => {
    const database_ = database();
    expect(() =>
      transaction(database_, () => {
        run(database_, "INSERT INTO items (id, name) VALUES (1, 'one')");
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(database_.isTransaction).toBe(false);
    expect(all(database_, 'SELECT id, name FROM items', itemSchema)).toStrictEqual([]);
  });
});
