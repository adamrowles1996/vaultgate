/**
 * What vaultgate remembers about each code target between calls (ACT-108,
 * ACT-115). The snapshot calls without a ref answer from is kept in the
 * database too (13.13, the engine's `snapshots`), so that after a restart a
 * moved ref is still answered from it with `stale: true`; nothing else about
 * a repository reaches the database. In memory only: the configured ref's
 * last resolution, the ref and trigger each snapshot was built for, the last
 * build and the last failure, and a short memory of failed builds so a call
 * does not refetch an archive that just failed. Every build, and every build
 * that could not start, ends in one audit event (ACT-116).
 */
import { recordBuild, recordRefusal, type Refusal } from './build-events.ts';
import { isRemembered } from './refusals.ts';

import type { BuildEnd, BuildOutcome, BuildRequest, Trigger } from './builds.ts';
import type { ResolvedReference } from './github.ts';
import type { Result } from '../../../result.ts';
import type { ActionError, ActionErrorCode } from '../../errors.ts';
import type { ConnectorServices } from '../connector.ts';

export interface CurrentSnapshot {
  readonly key: string;
  readonly commit: string;
  readonly ref: string;
  readonly indexedAt: number;
  readonly fingerprint: string;
}

/**
The configured ref's last resolution: the commit and the ref it came from, or why it failed.
*/
export type Resolution =
  | { readonly at: number; readonly commit: string; readonly ref: string }
  | { readonly at: number; readonly failure: ActionErrorCode };

export interface BuildRecord {
  readonly at: number;
  /**
  Absent when the build could not start: the ref did not resolve, or the credential was unavailable.
  */
  readonly commit?: string;
  readonly trigger: Trigger;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface SnapshotNote {
  readonly ref: string;
  readonly trigger: Trigger;
}

export interface TargetState {
  resolution: Resolution | undefined;
  /**
  The commit the configured ref last resolved to; a failed resolution since leaves it as it was.
  */
  resolvedCommit: string | undefined;
  /**
  The snapshot calls without a ref answer from; changed through `setCurrent` only, which keeps it.
  */
  readonly current: CurrentSnapshot | undefined;
  lastBuild: BuildRecord | undefined;
  lastFailure: BuildRecord | undefined;
  /**
  The ref and trigger each snapshot this process built was built for, by key, for the page.
  */
  readonly notes: Map<string, SnapshotNote>;
  readonly failed: Map<string, { readonly reason: string; readonly at: number }>;
}

export interface CodeState {
  target(id: string): TargetState;
  peek(id: string): TargetState | undefined;
  /**
  The target's snapshots are gone (a reset, a deletion): everything about it is forgotten, kept row too.
  */
  drop(id: string): void;
  /**
  ACT-108: the snapshot calls without a ref answer from, kept in the database as it changes.
  */
  setCurrent(id: string, current: CurrentSnapshot | undefined): void;
  resolved(targetId: string, resolved: Result<ResolvedReference, ActionError>): void;
  /**
  A build's end: recorded in the audit trail always, and on the target's state unless it was abandoned.
  */
  finished(request: BuildRequest, outcome: BuildOutcome, ended: BuildEnd): void;
  refused(refusal: Refusal): void;
}

export interface StateDependencies {
  readonly services: Pick<ConnectorServices, 'audit' | 'now' | 'snapshots'>;
  readonly fingerprintOf: (request: BuildRequest) => string;
  readonly keyOf: (request: BuildRequest) => string;
}

/**
The state as this module holds it: `current` changes here only, through `setCurrent`.
*/
type HeldTarget = { -readonly [Key in keyof TargetState]: TargetState[Key] };

function isSame(left: CurrentSnapshot | undefined, right: CurrentSnapshot | undefined): boolean {
  return (
    left?.key === right?.key && left?.ref === right?.ref && left?.indexedAt === right?.indexedAt
  );
}

function emptyTarget(): HeldTarget {
  return {
    resolution: undefined,
    resolvedCommit: undefined,
    current: undefined,
    lastBuild: undefined,
    lastFailure: undefined,
    notes: new Map(),
    failed: new Map(),
  };
}

const MS_PER_SECOND = 1000;

/**
 * A failure kept for the refresh interval (ACT-112); older ones, which no
 * call reads any more, go as it is written, so failed builds of refs that
 * calls named cannot pile up.
 */
function remember(
  found: TargetState,
  failure: { readonly key: string; readonly reason: string; readonly at: number },
  intervalMs: number,
): void {
  for (const [key, kept] of found.failed) {
    if (failure.at - kept.at >= intervalMs) {
      found.failed.delete(key);
    }
  }
  found.failed.set(failure.key, { reason: failure.reason, at: failure.at });
}

function currentAfter(
  dependencies: StateDependencies,
  target: TargetState,
  request: BuildRequest,
  meta: { readonly created_at: number },
): CurrentSnapshot | undefined {
  // A configured build becomes current only while the configured ref still
  // points at its commit: an older commit's build that finishes after the ref
  // moved on is kept on the page but never answered from.
  const isCurrentReference = request.configured && target.resolvedCommit === request.commit;
  return isCurrentReference
    ? {
        key: dependencies.keyOf(request),
        commit: request.commit,
        ref: request.ref,
        indexedAt: meta.created_at,
        fingerprint: dependencies.fingerprintOf(request),
      }
    : target.current;
}

/**
The targets this process remembers, and the one way their current snapshot changes (ACT-108).
*/
interface Held {
  readonly targets: Map<string, HeldTarget>;
  readonly target: (id: string) => HeldTarget;
  readonly setCurrent: (id: string, current: CurrentSnapshot | undefined) => void;
}

function hold(services: StateDependencies['services']): Held {
  const targets = new Map<string, HeldTarget>();
  function target(id: string): HeldTarget {
    const found = targets.get(id) ?? emptyTarget();
    targets.set(id, found);
    return found;
  }
  // ACT-108: what the database kept, so the first call after a restart can answer stale.
  for (const { targetId, ...current } of services.snapshots.load()) {
    target(targetId).current = current;
  }
  return {
    targets,
    target,
    setCurrent: (id, current) => {
      const found = target(id);
      if (isSame(found.current, current)) {
        return;
      }
      found.current = current;
      if (current === undefined) {
        services.snapshots.forget(id);
      } else {
        services.snapshots.keep({ targetId: id, ...current });
      }
    },
  };
}

/**
A build's end, as `finished` hears of it.
*/
interface Ended {
  readonly request: BuildRequest;
  readonly outcome: BuildOutcome;
  readonly ended: BuildEnd;
}

function finished(dependencies: StateDependencies, held: Held, end: Ended): void {
  const { services } = dependencies;
  const { request, outcome, ended } = end;
  const { durationMs } = ended;
  recordBuild(services, request, outcome, durationMs);
  if (ended.isAbandoned) {
    return;
  }
  const found = held.target(request.targetId);
  const at = services.now();
  const key = dependencies.keyOf(request);
  const { commit, trigger } = request;
  const reason = outcome.ok ? {} : { reason: outcome.reason };
  found.lastBuild = { at, commit, trigger, durationMs, ...reason };
  if (outcome.ok) {
    found.failed.delete(key);
    found.notes.set(key, { ref: request.ref, trigger });
    held.setCurrent(request.targetId, currentAfter(dependencies, found, request, outcome.meta));
  } else {
    found.lastFailure = found.lastBuild;
    if (isRemembered(outcome.reason)) {
      const intervalMs = request.documents.policy.refresh_interval_s * MS_PER_SECOND;
      remember(found, { key, reason: outcome.reason, at }, intervalMs);
    }
  }
}

export function createCodeState(dependencies: StateDependencies): CodeState {
  const { services } = dependencies;
  const held = hold(services);
  const { targets, target, setCurrent } = held;
  return {
    target,
    peek: (id) => targets.get(id),
    drop(id) {
      targets.delete(id);
      services.snapshots.forget(id);
    },
    setCurrent,
    resolved(targetId, resolved) {
      const found = target(targetId);
      if (!resolved.ok) {
        found.resolution = { at: services.now(), failure: resolved.error.code };
        return;
      }
      const { commit, ref } = resolved.value;
      found.resolution = { at: services.now(), commit, ref };
      found.resolvedCommit = commit;
    },
    finished: (request, outcome, ended) => {
      finished(dependencies, held, { request, outcome, ended });
    },
    refused(refusal) {
      recordRefusal(services, refusal);
      const found = target(refusal.targetId);
      const { trigger, reason } = refusal;
      found.lastBuild = { at: services.now(), trigger, durationMs: 0, reason };
      found.lastFailure = found.lastBuild;
    },
  };
}
