import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { unwrapOk } from '../../test-support/result.ts';
import { migrate } from '../migrate.ts';
import { all, run } from '../query.ts';

import { MIGRATIONS } from './index.ts';

const NOW = new Date('2026-09-25T10:00:00Z');
const grantSchema = z.object({
  target_id: z.string(),
  client_id: z.string(),
  granted_by: z.string(),
});
const targetSchema = z.object({ id: z.string(), connector: z.string(), revision: z.number() });
const nameSchema = z.object({ name: z.string() });

function database(): DatabaseSync {
  const opened = new DatabaseSync(':memory:');
  opened.exec('PRAGMA foreign_keys = ON');
  return opened;
}

function insertTarget(store: DatabaseSync, id: string, connector: string): void {
  run(
    store,
    'INSERT INTO action_targets (id, name, description, connector, destination, internal, ' +
      'credential, policy, enabled, revision, created_at, updated_at, updated_by) VALUES ' +
      `(?, ?, '', ?, '{}', 0, '{"item_id":"item-login","mapping":{}}', '{}', 1, 3, 0, 0, 'operator-1')`,
    id,
    `name-${id}`,
    connector,
  );
}

function populatedAtVersion4(): DatabaseSync {
  const store = database();
  unwrapOk(migrate(store, MIGRATIONS.slice(0, 4), NOW));
  run(
    store,
    "INSERT INTO oauth_clients (id, client_id, mode, client_name, redirect_uris, metadata, created_at) VALUES ('row-1', 'vg_c_agent', 'dcr', 'Agent', '[]', '{}', 0)",
  );
  insertTarget(store, 'target-1', 'http');
  run(
    store,
    "INSERT INTO action_grants (target_id, client_id, granted_at, granted_by, revoked_at) VALUES ('target-1', 'vg_c_agent', 1, 'operator-1', NULL)",
  );
  return store;
}

function indexNames(store: DatabaseSync): string[] {
  return all(
    store,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('action_targets', 'action_grants') AND name LIKE 'idx_%' ORDER BY name",
    nameSchema,
  ).map((row) => row.name);
}

describe('migration 005: the code connector (13.13, ADR 0008)', () => {
  it('13.13 rebuilds action_targets to admit code, keeping every row, every grant and every index', () => {
    const store = populatedAtVersion4();
    expect(() => {
      insertTarget(store, 'too-early', 'code');
    }).toThrow(/CHECK constraint failed/u);
    expect(unwrapOk(migrate(store, MIGRATIONS, NOW))).toStrictEqual({
      applied: [5],
      version: 5,
    });
    insertTarget(store, 'target-2', 'code');
    expect(
      all(store, 'SELECT id, connector, revision FROM action_targets ORDER BY id', targetSchema),
    ).toStrictEqual([
      { id: 'target-1', connector: 'http', revision: 3 },
      { id: 'target-2', connector: 'code', revision: 3 },
    ]);
    expect(
      all(store, 'SELECT target_id, client_id, granted_by FROM action_grants', grantSchema),
    ).toStrictEqual([{ target_id: 'target-1', client_id: 'vg_c_agent', granted_by: 'operator-1' }]);
    expect(indexNames(store)).toStrictEqual([
      'idx_action_grants_client_id',
      'idx_action_targets_name',
    ]);
    expect(
      all(store, "SELECT name FROM sqlite_master WHERE name LIKE '%_005'", nameSchema),
    ).toStrictEqual([]);
  });

  it('13.13 still refuses a connector it does not know, a repeated name, and a grant of a target that does not exist', () => {
    const store = populatedAtVersion4();
    unwrapOk(migrate(store, MIGRATIONS, NOW));
    expect(() => {
      insertTarget(store, 'target-3', 'smtp');
    }).toThrow(/CHECK constraint failed/u);
    expect(() => {
      run(store, "UPDATE action_targets SET name = 'name-target-1' WHERE id = 'target-1'");
      insertTarget(store, 'target-1', 'code');
    }).toThrow(/UNIQUE constraint failed/u);
    expect(() => {
      run(
        store,
        "INSERT INTO action_grants (target_id, client_id, granted_at, granted_by) VALUES ('missing', 'vg_c_agent', 1, 'operator-1')",
      );
    }).toThrow(/FOREIGN KEY constraint failed/u);
  });

  it('ACT-9 deleting a target still cascades to its grants, and deleting a client to its grants, after the rebuild', () => {
    const store = populatedAtVersion4();
    unwrapOk(migrate(store, MIGRATIONS, NOW));
    insertTarget(store, 'target-2', 'code');
    run(
      store,
      "INSERT INTO action_grants (target_id, client_id, granted_at, granted_by) VALUES ('target-2', 'vg_c_agent', 1, 'operator-1')",
    );
    run(store, "DELETE FROM action_targets WHERE id = 'target-1'");
    expect(
      all(store, 'SELECT target_id, client_id, granted_by FROM action_grants', grantSchema).map(
        (row) => row.target_id,
      ),
    ).toStrictEqual(['target-2']);
    run(store, "DELETE FROM oauth_clients WHERE client_id = 'vg_c_agent'");
    expect(
      all(store, 'SELECT target_id, client_id, granted_by FROM action_grants', grantSchema),
    ).toStrictEqual([]);
  });
});
