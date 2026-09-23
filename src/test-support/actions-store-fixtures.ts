/**
 * Rows in the actions tables as tests read and seed them: an open browser
 * session (as M15's registry will write it, so the closing paths can be
 * proven now), the grant and session rows, a raw target row for tests that
 * bypass the save-time checks on purpose, and the field path of a problem.
 */
import { z } from 'zod';

import { type CallRow, recordCall } from '../actions/calls.ts';
import { all, run } from '../storage/query.ts';

import { DEFAULT_TARGET, OPERATOR_ID } from './actions-fixtures.ts';

import type { TargetRow } from '../actions/targets-schemas.ts';
import type { DatabaseSync } from 'node:sqlite';

const SESSION =
  'INSERT INTO action_sessions (id_hash, target_id, client_id, token_prefix, opened_at, ' +
  'last_used_at, expires_at, closed_at, close_reason, calls) VALUES (?, ?, ?, ?, 0, 0, 900, NULL, NULL, 0)';

const sessionRowSchema = z.object({ id_hash: z.string(), close_reason: z.string().nullable() });
const grantRowSchema = z.object({ client_id: z.string(), revoked_at: z.number().nullable() });

export type SessionRow = z.output<typeof sessionRowSchema>;
export type GrantRow = z.output<typeof grantRowSchema>;

export function openSession(
  database: DatabaseSync,
  idHash: string,
  targetId: string,
  clientId: string,
): void {
  run(database, SESSION, idHash, targetId, clientId, 'prefix');
}

export function sessionRows(database: DatabaseSync): readonly SessionRow[] {
  return all(
    database,
    'SELECT id_hash, close_reason FROM action_sessions ORDER BY id_hash',
    sessionRowSchema,
  );
}

export function grantRows(database: DatabaseSync, targetId: string): readonly GrantRow[] {
  return all(
    database,
    'SELECT client_id, revoked_at FROM action_grants WHERE target_id = ? ORDER BY client_id',
    grantRowSchema,
    targetId,
  );
}

/**
The field path of each problem a target write reports (`path: message`).
*/
export function problemPaths(problems: readonly string[]): readonly string[] {
  return problems.map((problem) => problem.split(':', 1)[0] ?? '');
}

/**
A stored `http` target row on the fixture login item, for tests that bypass the save-time checks on purpose.
*/
export function fixtureTargetRow(overrides: Partial<TargetRow> = {}): TargetRow {
  return {
    id: 'row-1',
    name: 'row',
    description: '',
    connector: 'http',
    destination: { base_url: DEFAULT_TARGET.base_url },
    internal: false,
    credential: { item_id: DEFAULT_TARGET.item_id, mapping: DEFAULT_TARGET.mapping },
    policy: { allowed_paths: ['/**'] },
    enabled: true,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: OPERATOR_ID,
    ...overrides,
  };
}

/**
A completed `action_calls` row on the fixture target, as the engine writes one (ACT-60).
*/
export function insertCallRow(database: DatabaseSync, overrides: Partial<CallRow> = {}): void {
  const row: CallRow = {
    id: 'call-1',
    at: 0,
    targetId: 'row-1',
    targetName: DEFAULT_TARGET.name,
    connector: 'http',
    revision: 1,
    tool: 'http_request',
    sessionIdHash: undefined,
    clientId: 'vg_c_agent',
    tokenPrefix: 'aabbccdd0011',
    operation: 'read',
    classification: 'GET',
    arguments: { target: DEFAULT_TARGET.name, method: 'GET', path: '/v1/me' },
    outputBytes: 12,
    outputTruncated: false,
    durationMs: 3,
    outcome: 'ok',
    elicitation: 'not_required',
    confirmationNonce: undefined,
    requestId: 'req-1',
    ip: '203.0.113.9',
    ...overrides,
  };
  recordCall(database, row);
}
