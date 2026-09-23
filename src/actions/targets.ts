/**
 * The targets service (spec §13.3, §13.4): what the account page calls to
 * create, edit, enable, disable, delete and grant targets, plus the consent
 * revocation callback of ACT-10 the composition layer wires into the OAuth
 * layer. Every change records its ACT-7 event and bumps the revision (ACT-1).
 */
import { fail, ok, type Result } from '../result.ts';
import { transaction } from '../storage/query.ts';

import { closeSessions } from './sessions.ts';
import {
  recordTargetEvent,
  summariseTarget,
  type TargetResult,
  type TargetsContext,
  type TargetSummary,
  withTarget,
} from './targets-context.ts';
import { createTarget, removeTarget, setTargetEnabled, updateTarget } from './targets-lifecycle.ts';
import { createTargetsRepo, type TargetsRepo } from './targets-repo.ts';
import { TargetProblems } from './targets-schemas.ts';

import type { ActionsAuditSink } from './audit.ts';
import type { CheckDependencies } from './targets-checks.ts';
import type { DatabaseSync } from 'node:sqlite';

export type { TargetResult, TargetSummary } from './targets-context.ts';

export interface TargetsServiceDependencies extends CheckDependencies {
  readonly database: DatabaseSync;
  readonly audit: ActionsAuditSink;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface TargetsService {
  readonly repo: TargetsRepo;
  list(): readonly TargetSummary[];
  get(id: string): TargetSummary | undefined;
  create(input: unknown, operatorId: string): Promise<TargetResult>;
  /**
  `name` and `connector` are fixed at creation; everything else may change.
  */
  update(id: string, input: unknown, operatorId: string): Promise<TargetResult>;
  setEnabled(id: string, isEnabled: boolean, operatorId: string): TargetResult;
  remove(id: string, operatorId: string): Result<void, TargetProblems>;
  grant(id: string, clientId: string, operatorId: string): TargetResult;
  revokeGrant(id: string, clientId: string, operatorId: string): TargetResult;
  /**
  ACT-10: wired by composition into the OAuth consent revocation path; revokes the client's grants and closes its sessions.
  */
  onConsentRevoked(clientId: string): { readonly grants: number; readonly sessions: number };
}

/**
ACT-9: a grant joins a target to a registered client; revoking one closes the client's sessions.
*/
function grantTarget(
  context: TargetsContext,
  id: string,
  clientId: string,
  operatorId: string,
): TargetResult {
  return withTarget(context, id, (row) => {
    if (!context.repo.clientExists(clientId)) {
      return fail(new TargetProblems(['client_id: no such client']));
    }
    context.repo.grant(id, clientId, context.now(), operatorId);
    recordTargetEvent(context, { action: 'grant_added', row, operatorId, clientId });
    return ok(summariseTarget(context.repo, row));
  });
}

function revokeTargetGrant(
  context: TargetsContext,
  id: string,
  clientId: string,
  operatorId: string,
): TargetResult {
  return withTarget(context, id, (row) => {
    const at = context.now();
    transaction(context.database, () => {
      context.repo.revokeGrant(id, clientId, at);
      const sessions = closeSessions(context.database, { clientId }, 'revoked', at);
      recordTargetEvent(context, {
        action: 'grant_removed',
        row,
        operatorId,
        clientId,
        details: { sessions },
      });
    });
    return ok(summariseTarget(context.repo, row));
  });
}

export function createTargetsService(dependencies: TargetsServiceDependencies): TargetsService {
  const { database, audit, now, newId, ...checks } = dependencies;
  const repo = createTargetsRepo(database);
  const context: TargetsContext = { database, repo, audit, checks, now, newId };
  return {
    repo,
    list: () => repo.list().map((row) => summariseTarget(repo, row)),
    get(id) {
      const row = repo.findById(id);
      return row === undefined ? undefined : summariseTarget(repo, row);
    },
    create: (input, operatorId) => createTarget(context, input, operatorId),
    update: (id, input, operatorId) => updateTarget(context, id, input, operatorId),
    setEnabled: (id, isEnabled, operatorId) => setTargetEnabled(context, id, isEnabled, operatorId),
    remove: (id, operatorId) => removeTarget(context, id, operatorId),
    grant: (id, clientId, operatorId) => grantTarget(context, id, clientId, operatorId),
    revokeGrant: (id, clientId, operatorId) => revokeTargetGrant(context, id, clientId, operatorId),
    onConsentRevoked(clientId) {
      const at = now();
      return transaction(database, () => ({
        grants: repo.revokeGrantsForClient(clientId, at),
        sessions: closeSessions(database, { clientId }, 'revoked', at),
      }));
    },
  };
}
