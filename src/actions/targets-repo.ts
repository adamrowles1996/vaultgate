/**
 * The repository over `action_targets` and `action_grants` (spec §13.13):
 * rows in and out, revision bumped on every change (ACT-1), grants per
 * client with a `revoked_at` so a removed grant leaves a record (ACT-9).
 */
import { z } from 'zod';

import { all, get, run } from '../storage/query.ts';

import type { TargetCredential, TargetRow } from './targets-schemas.ts';
import type { DatabaseSync } from 'node:sqlite';

const json = z.string().transform((text): unknown => JSON.parse(text));
const flag = z.number().transform((value) => value === 1);

const credentialSchema = z.object({ item_id: z.string(), mapping: z.unknown() });

const targetRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  connector: z.enum(['http', 'sql', 'ssh', 'winrm', 'browser']),
  destination: json,
  internal: flag,
  credential: json.pipe(credentialSchema),
  policy: json,
  enabled: flag,
  revision: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
  updated_by: z.string(),
});

const grantRowSchema = z.object({
  target_id: z.string(),
  client_id: z.string(),
  granted_at: z.number(),
  granted_by: z.string(),
  revoked_at: z.number().nullable(),
});

const idRowSchema = z.object({ id: z.string() });

export interface GrantRecord {
  readonly targetId: string;
  readonly clientId: string;
  readonly grantedAt: number;
  readonly grantedBy: string;
  readonly revokedAt: number | undefined;
}

/**
The columns an edit may change; `name` and `connector` are fixed at creation (ACT-1).
*/
export interface TargetChanges {
  readonly description: string;
  readonly destination: unknown;
  readonly internal: boolean;
  readonly credential: TargetCredential;
  readonly policy: unknown;
}

export interface TargetsRepo {
  findById(id: string): TargetRow | undefined;
  findByName(name: string): TargetRow | undefined;
  list(): readonly TargetRow[];
  /**
  Enabled or not, valid or not: every target the client holds an active grant on, by name.
  */
  listGranted(clientId: string): readonly TargetRow[];
  insert(row: TargetRow): void;
  /**
  Applies the changes and bumps the revision (ACT-1).
  */
  update(id: string, changes: TargetChanges, at: number, by: string): void;
  setEnabled(id: string, isEnabled: boolean, at: number, by: string): void;
  remove(id: string): number;
  /**
  ACT-9: a grant joins a target to a registered OAuth client, never to an arbitrary id.
  */
  clientExists(clientId: string): boolean;
  isGranted(targetId: string, clientId: string): boolean;
  listGrants(targetId: string): readonly GrantRecord[];
  grant(targetId: string, clientId: string, at: number, by: string): void;
  revokeGrant(targetId: string, clientId: string, at: number): number;
  /**
  ACT-10: every active grant of the client, on consent revocation.
  */
  revokeGrantsForClient(clientId: string, at: number): number;
}

const COLUMNS =
  'id, name, description, connector, destination, internal, credential, policy, enabled, ' +
  'revision, created_at, updated_at, updated_by';

function toRow(row: z.output<typeof targetRowSchema>): TargetRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    connector: row.connector,
    destination: row.destination,
    internal: row.internal,
    credential: row.credential,
    policy: row.policy,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toGrant(row: z.output<typeof grantRowSchema>): GrantRecord {
  return {
    targetId: row.target_id,
    clientId: row.client_id,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function targetReads(
  database: DatabaseSync,
): Pick<TargetsRepo, 'findById' | 'findByName' | 'list' | 'listGranted'> {
  const one = (sql: string, ...parameters: (string | number)[]): TargetRow | undefined => {
    const row = get(database, sql, targetRowSchema, ...parameters);
    return row === undefined ? undefined : toRow(row);
  };
  const many = (sql: string, ...parameters: (string | number)[]): readonly TargetRow[] =>
    all(database, sql, targetRowSchema, ...parameters).map((row) => toRow(row));
  return {
    findById: (id) => one(`SELECT ${COLUMNS} FROM action_targets WHERE id = ?`, id),
    findByName: (name) => one(`SELECT ${COLUMNS} FROM action_targets WHERE name = ?`, name),
    list: () => many(`SELECT ${COLUMNS} FROM action_targets ORDER BY name`),
    listGranted: (clientId) =>
      many(
        `SELECT ${COLUMNS.replaceAll(/(\w+)/g, 't.$1')} FROM action_targets t
          JOIN action_grants g ON g.target_id = t.id
          WHERE g.client_id = ? AND g.revoked_at IS NULL ORDER BY t.name`,
        clientId,
      ),
  };
}

function targetWrites(
  database: DatabaseSync,
): Pick<TargetsRepo, 'insert' | 'update' | 'setEnabled' | 'remove'> {
  return {
    insert(row) {
      run(
        database,
        `INSERT INTO action_targets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.name,
        row.description,
        row.connector,
        JSON.stringify(row.destination),
        row.internal ? 1 : 0,
        JSON.stringify(row.credential),
        JSON.stringify(row.policy),
        row.enabled ? 1 : 0,
        row.revision,
        row.createdAt,
        row.updatedAt,
        row.updatedBy,
      );
    },
    update(id, changes, at, by) {
      run(
        database,
        `UPDATE action_targets SET description = ?, destination = ?, internal = ?, credential = ?,
          policy = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
        changes.description,
        JSON.stringify(changes.destination),
        changes.internal ? 1 : 0,
        JSON.stringify(changes.credential),
        JSON.stringify(changes.policy),
        at,
        by,
        id,
      );
    },
    setEnabled(id, isEnabled, at, by) {
      run(
        database,
        `UPDATE action_targets SET enabled = ?, revision = revision + 1, updated_at = ?,
          updated_by = ? WHERE id = ?`,
        isEnabled ? 1 : 0,
        at,
        by,
        id,
      );
    },
    remove: (id) => run(database, 'DELETE FROM action_targets WHERE id = ?', id),
  };
}

function grantQueries(
  database: DatabaseSync,
): Pick<
  TargetsRepo,
  'clientExists' | 'isGranted' | 'listGrants' | 'grant' | 'revokeGrant' | 'revokeGrantsForClient'
> {
  return {
    clientExists: (clientId) =>
      get(
        database,
        'SELECT client_id AS id FROM oauth_clients WHERE client_id = ?',
        idRowSchema,
        clientId,
      ) !== undefined,
    isGranted: (targetId, clientId) =>
      get(
        database,
        'SELECT target_id AS id FROM action_grants WHERE target_id = ? AND client_id = ? AND revoked_at IS NULL',
        idRowSchema,
        targetId,
        clientId,
      ) !== undefined,
    listGrants: (targetId) =>
      all(
        database,
        'SELECT * FROM action_grants WHERE target_id = ? ORDER BY client_id',
        grantRowSchema,
        targetId,
      ).map((row) => toGrant(row)),
    grant(targetId, clientId, at, by) {
      run(
        database,
        `INSERT INTO action_grants (target_id, client_id, granted_at, granted_by, revoked_at)
          VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT (target_id, client_id) DO UPDATE SET granted_at = excluded.granted_at,
            granted_by = excluded.granted_by, revoked_at = NULL`,
        targetId,
        clientId,
        at,
        by,
      );
    },
    revokeGrant: (targetId, clientId, at) =>
      run(
        database,
        'UPDATE action_grants SET revoked_at = ? WHERE target_id = ? AND client_id = ? AND revoked_at IS NULL',
        at,
        targetId,
        clientId,
      ),
    revokeGrantsForClient: (clientId, at) =>
      run(
        database,
        'UPDATE action_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL',
        at,
        clientId,
      ),
  };
}

export function createTargetsRepo(database: DatabaseSync): TargetsRepo {
  return { ...targetReads(database), ...targetWrites(database), ...grantQueries(database) };
}
