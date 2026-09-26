/**
 * What every target operation shares (spec §13.3): the repository, the
 * audit sink and the clock it runs against, the summary the account page
 * renders (ACT-1's `valid`/`invalid` state with the reasons), the ACT-7
 * audit record and the revision bump of ACT-1.
 */
import { fail, type Result } from '../result.ts';

import {
  type TargetDocuments,
  type TargetRow,
  TargetProblems,
  validateTarget,
} from './targets-schemas.ts';

import type { ActionsAuditAction, ActionsAuditSink } from './audit.ts';
import type { CheckDependencies } from './targets-checks.ts';
import type { GrantRecord, TargetsRepo } from './targets-repo.ts';
import type { AuditDetails } from '../audit/event.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
 * ACT-108, ACT-109: told of every saved, enabled and deleted target, after
 * the row is written and before it is removed; `previous` is the target's
 * documents before an update, when they validated.
 */
export interface TargetsObserver {
  saved(row: TargetRow, previous: TargetDocuments | undefined): void;
  removed(row: TargetRow): void;
}

export interface TargetsContext {
  readonly database: DatabaseSync;
  readonly repo: TargetsRepo;
  readonly audit: ActionsAuditSink;
  readonly checks: CheckDependencies;
  readonly now: () => number;
  readonly newId: () => string;
  readonly observer: TargetsObserver | undefined;
}

/**
The documents of a row as they validate now, for an observer comparing a revision with its predecessor.
*/
export function documentsOf(row: TargetRow): TargetDocuments | undefined {
  const validated = validateTarget(row);
  return validated.state === 'valid' ? validated.documents : undefined;
}

/**
A target as the pages render it: the row, whether it validates (ACT-1), why not, and its grants.
*/
export interface TargetSummary extends TargetRow {
  readonly state: 'valid' | 'invalid';
  readonly problems: readonly string[];
  readonly destinationSummary: string | undefined;
  readonly grants: readonly GrantRecord[];
}

export type TargetResult = Result<TargetSummary, TargetProblems>;

export function summariseTarget(repo: TargetsRepo, row: TargetRow): TargetSummary {
  const validated = validateTarget(row);
  const grants = repo.listGrants(row.id);
  return validated.state === 'valid'
    ? {
        ...row,
        state: 'valid',
        problems: [],
        destinationSummary: validated.schemas.summariseDestination(validated.documents.destination),
        grants,
      }
    : {
        ...row,
        state: 'invalid',
        problems: validated.problems,
        destinationSummary: undefined,
        grants,
      };
}

/**
One ACT-7 event: the action, the target it concerns, the operator, and for grants the client.
*/
export interface TargetEvent {
  readonly action: ActionsAuditAction;
  readonly row: TargetRow;
  readonly operatorId: string;
  readonly clientId?: string;
  readonly details?: AuditDetails;
}

/**
ACT-7: the target name, connector and operator on every change; field names, never values.
*/
export function recordTargetEvent(context: TargetsContext, event: TargetEvent): void {
  context.audit.record({
    category: 'actions',
    action: event.action,
    outcome: 'ok',
    operatorId: event.operatorId,
    clientId: event.clientId,
    details: { target: event.row.name, connector: event.row.connector, ...event.details },
  });
}

/**
ACT-1: what the row becomes after a change; the repository writes the same revision bump.
*/
export function bumped(
  row: TargetRow,
  changes: Partial<TargetRow>,
  at: number,
  by: string,
): TargetRow {
  return { ...row, ...changes, revision: row.revision + 1, updatedAt: at, updatedBy: by };
}

export function unknownTarget(): Result<never, TargetProblems> {
  return fail(new TargetProblems(['id: no such target']));
}

/**
Runs `work` on the row of that id, or answers the one problem an unknown id has.
*/
export function withTarget(
  context: TargetsContext,
  id: string,
  work: (row: TargetRow) => TargetResult,
): TargetResult {
  const row = context.repo.findById(id);
  return row === undefined ? unknownTarget() : work(row);
}
