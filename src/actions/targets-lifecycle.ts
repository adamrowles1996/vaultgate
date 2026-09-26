/**
 * The lifecycle of a target (spec §13.3): create and update behind the
 * save-time checks of `targets-checks.ts`, enable, disable and delete, each
 * bumping the revision (ACT-1), closing open sessions where the target
 * changed under them (ACT-96) and recording its ACT-7 event; deleting
 * cascades grants and keeps the calls (ACT-8).
 */
import { fail, ok } from '../result.ts';
import { transaction } from '../storage/query.ts';

import { closeSessions } from './sessions.ts';
import { type CheckReport, changedFields, checkChanges, prepareChanges } from './targets-checks.ts';
import {
  bumped,
  documentsOf,
  recordTargetEvent,
  summariseTarget,
  type TargetResult,
  type TargetsContext,
  unknownTarget,
  withTarget,
} from './targets-context.ts';
import { targetInputSchema, TargetProblems, type TargetRow } from './targets-schemas.ts';

import type { Result } from '../result.ts';

const NAME_TAKEN = 'name: a target of that name already exists';

function shapeProblems(error: {
  readonly issues: readonly { path: PropertyKey[]; message: string }[];
}) {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

export async function createTarget(
  context: TargetsContext,
  input: unknown,
  operatorId: string,
): Promise<TargetResult> {
  const shape = targetInputSchema.safeParse(input);
  if (!shape.success) {
    return fail(new TargetProblems(shapeProblems(shape.error)));
  }
  const { name, connector, enabled, ...changes } = shape.data;
  if (context.repo.findByName(name) !== undefined) {
    return fail(new TargetProblems([NAME_TAKEN]));
  }
  const prepared = await prepareChanges(context.checks, connector, changes);
  if (!prepared.ok) {
    return prepared;
  }
  const at = context.now();
  const row: TargetRow = {
    ...prepared.value.changes,
    id: context.newId(),
    name,
    connector,
    enabled,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    updatedBy: operatorId,
  };
  context.repo.insert(row);
  recordTargetEvent(context, { action: 'target_created', row, operatorId });
  context.observer?.saved(row, undefined);
  return ok(summariseTarget(context.repo, row));
}

/**
 * ACT-118: every check a create would run and what each found, the name's
 * as well; nothing is written. Unlike a save, a taken name does not stop
 * the rest, so one check reports everything at once.
 */
export async function checkNewTarget(
  context: TargetsContext,
  input: unknown,
): Promise<CheckReport> {
  const shape = targetInputSchema.safeParse(input);
  if (!shape.success) {
    const problems = shapeProblems(shape.error);
    return { problems, endpoints: [], rules: problems };
  }
  const { name, connector, ...rest } = shape.data;
  const { enabled: _enabled, ...changes } = rest;
  const report = await checkChanges(context.checks, connector, changes);
  return context.repo.findByName(name) === undefined
    ? report
    : {
        ...report,
        problems: [NAME_TAKEN, ...report.problems],
        rules: [NAME_TAKEN, ...report.rules],
      };
}

/**
`name` and `connector` are fixed at creation; everything else may change.
*/
export async function updateTarget(
  context: TargetsContext,
  id: string,
  input: unknown,
  operatorId: string,
): Promise<TargetResult> {
  const before = context.repo.findById(id);
  if (before === undefined) {
    return unknownTarget();
  }
  const prepared = await prepareChanges(context.checks, before.connector, input);
  if (!prepared.ok) {
    return prepared;
  }
  const changed = changedFields(before, prepared.value.changes);
  if (changed.length === 0) {
    return ok(summariseTarget(context.repo, before));
  }
  const at = context.now();
  transaction(context.database, () => {
    const sessions = closeSessions(context.database, { targetId: id }, 'target_changed', at);
    recordTargetEvent(context, {
      action: 'target_updated',
      row: before,
      operatorId,
      details: { changed, sessions },
    });
    context.repo.update(id, prepared.value.changes, at, operatorId);
  });
  const after = bumped(before, prepared.value.changes, at, operatorId);
  context.observer?.saved(after, documentsOf(before));
  return ok(summariseTarget(context.repo, after));
}

export function setTargetEnabled(
  context: TargetsContext,
  id: string,
  isEnabled: boolean,
  operatorId: string,
): TargetResult {
  return withTarget(context, id, (row) => {
    const at = context.now();
    transaction(context.database, () => {
      const sessions = isEnabled
        ? 0
        : closeSessions(context.database, { targetId: id }, 'target_changed', at);
      recordTargetEvent(context, {
        action: isEnabled ? 'target_enabled' : 'target_disabled',
        row,
        operatorId,
        details: { sessions },
      });
      context.repo.setEnabled(id, isEnabled, at, operatorId);
    });
    const after = bumped(row, { enabled: isEnabled }, at, operatorId);
    context.observer?.saved(after, undefined);
    return ok(summariseTarget(context.repo, after));
  });
}

/**
ACT-8: grants go with the target (cascade), sessions are closed, calls stay.
*/
export function removeTarget(
  context: TargetsContext,
  id: string,
  operatorId: string,
): Result<void, TargetProblems> {
  const row = context.repo.findById(id);
  if (row === undefined) {
    return unknownTarget();
  }
  const at = context.now();
  context.observer?.removed(row);
  transaction(context.database, () => {
    const sessions = closeSessions(context.database, { targetId: id }, 'target_changed', at);
    context.repo.remove(id);
    recordTargetEvent(context, {
      action: 'target_deleted',
      row,
      operatorId,
      details: { sessions },
    });
  });
  return ok(undefined);
}
