import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { unwrapOk } from '../../test-support/result.ts';
import { migrate } from '../migrate.ts';
import { all } from '../query.ts';

import { MIGRATIONS } from './index.ts';

const NOW = new Date('2026-11-13T23:00:00Z');
const columnSchema = z.object({ name: z.string() });
const relayNodeSchema = z.object({ relay_node: z.string().nullable() });

describe('migration 008: the relay node on a token (RELAY-17)', () => {
  it('RELAY-17 adds one nullable tokens.relay_node column after migration 7', () => {
    const store = new DatabaseSync(':memory:');
    const before = MIGRATIONS.slice(0, 7);
    expect(unwrapOk(migrate(store, before, NOW)).version).toBe(7);
    // A token from before the migration; its client and consent rows do not matter here.
    store.exec('PRAGMA foreign_keys = OFF');
    store.exec(
      "INSERT INTO tokens (id, token_hash, kind, family_id, client_id, consent_id, scopes, resource, issued_at, expires_at) VALUES ('t1', 'h1', 'access', 'f1', 'c', 'consent', '[]', 'r', 0, 1)",
    );
    expect(unwrapOk(migrate(store, MIGRATIONS, NOW))).toStrictEqual({ applied: [8], version: 8 });
    const names = all(store, "SELECT name FROM pragma_table_info('tokens')", columnSchema).map(
      (row) => row.name,
    );
    expect(names.at(-1)).toBe('relay_node');
    expect(
      all(store, "SELECT relay_node FROM tokens WHERE id = 't1'", relayNodeSchema),
    ).toStrictEqual([{ relay_node: null }]);
  });
});
