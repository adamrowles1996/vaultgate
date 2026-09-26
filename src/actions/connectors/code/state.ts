/**
 * What vaultgate remembers about each code target between calls (ACT-108,
 * ACT-115), in memory only: nothing about a repository reaches the database
 * (13.13). The configured ref's last resolution, the snapshot calls answer
 * from, the ref and trigger each snapshot was built for, the last build and
 * the last failure, and a short memory of failed builds so a call does not
 * refetch an archive that just failed. A restart forgets it all, and the
 * next call resolves and looks up afresh. Every build, and every build that
 * could not start, ends in one audit event (ACT-116).
 */
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
  current: CurrentSnapshot | undefined;
  lastBuild: BuildRecord | undefined;
  lastFailure: BuildRecord | undefined;
  /**
  The ref and trigger each snapshot this process built was built for, by key, for the page.
  */
  readonly notes: Map<string, SnapshotNote>;
  readonly failed: Map<string, { readonly reason: string; readonly at: number }>;
}

/**
A build that never started: which target, why, and what started it.
*/
export interface Refusal {
  readonly targetId: string;
  readonly targetName: string;
  readonly trigger: Trigger;
  readonly content: readonly string[];
  readonly reason: string;
}

export interface CodeState {
  target(id: string): TargetState;
  peek(id: string): TargetState | undefined;
  drop(id: string): void;
  resolved(targetId: string, resolved: Result<ResolvedReference, ActionError>): void;
  /**
  A build's end: recorded in the audit trail always, and on the target's state unless it was abandoned.
  */
  finished(request: BuildRequest, outcome: BuildOutcome, ended: BuildEnd): void;
  refused(refusal: Refusal): void;
}

export interface StateDependencies {
  readonly services: Pick<ConnectorServices, 'audit' | 'now'>;
  readonly fingerprintOf: (request: BuildRequest) => string;
  readonly keyOf: (request: BuildRequest) => string;
}

function emptyTarget(): TargetState {
  return {
    resolution: undefined,
    current: undefined,
    lastBuild: undefined,
    lastFailure: undefined,
    notes: new Map(),
    failed: new Map(),
  };
}

function counts(outcome: BuildOutcome): Readonly<Record<string, number | string>> {
  if (!outcome.ok) {
    return { reason: outcome.reason };
  }
  const { files, skipped, variants } = outcome.meta;
  return {
    files,
    chunks: Object.values(variants).reduce((sum, variant) => sum + variant.chunks, 0),
    skipped: skipped.links + skipped.special + skipped.excluded + skipped.large,
  };
}

/**
ACT-116: one event per build, with the counts or the reason; never a file name, a ref or content.
*/
function recordBuild(
  services: StateDependencies['services'],
  request: BuildRequest,
  outcome: BuildOutcome,
  durationMs: number,
): void {
  services.audit.record({
    category: 'actions',
    action: outcome.ok ? 'code_index_built' : 'code_index_failed',
    outcome: outcome.ok ? 'ok' : `error:${outcome.reason}`,
    durationMs,
    details: {
      target: request.targetName,
      connector: 'code',
      commit: request.commit,
      trigger: request.trigger,
      content: request.variants.map((variant) => variant.join('+')),
      ...counts(outcome),
    },
  });
}

function currentAfter(
  dependencies: StateDependencies,
  target: TargetState,
  request: BuildRequest,
  meta: { readonly created_at: number },
): CurrentSnapshot | undefined {
  const resolution = target.resolution;
  const resolved =
    resolution !== undefined && 'commit' in resolution ? resolution.commit : undefined;
  const isCurrentReference =
    request.configured && (resolved === undefined || resolved === request.commit);
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
A build that never started, in the audit trail; the record the page shows as the last build and failure.
*/
function recordRefusal(services: StateDependencies['services'], refusal: Refusal): BuildRecord {
  services.audit.record({
    category: 'actions',
    action: 'code_index_failed',
    outcome: `error:${refusal.reason}`,
    durationMs: 0,
    details: {
      target: refusal.targetName,
      connector: 'code',
      trigger: refusal.trigger,
      content: [refusal.content.join('+')],
      reason: refusal.reason,
    },
  });
  return { at: services.now(), trigger: refusal.trigger, durationMs: 0, reason: refusal.reason };
}

export function createCodeState(dependencies: StateDependencies): CodeState {
  const { services } = dependencies;
  const targets = new Map<string, TargetState>();

  function target(id: string): TargetState {
    const found = targets.get(id) ?? emptyTarget();
    targets.set(id, found);
    return found;
  }

  function finished(request: BuildRequest, outcome: BuildOutcome, ended: BuildEnd): void {
    const { durationMs } = ended;
    recordBuild(services, request, outcome, durationMs);
    if (ended.isAbandoned) {
      return;
    }
    const found = target(request.targetId);
    const at = services.now();
    const key = dependencies.keyOf(request);
    const { commit, trigger } = request;
    const reason = outcome.ok ? {} : { reason: outcome.reason };
    found.lastBuild = { at, commit, trigger, durationMs, ...reason };
    if (outcome.ok) {
      found.failed.delete(key);
      found.notes.set(key, { ref: request.ref, trigger });
      found.current = currentAfter(dependencies, found, request, outcome.meta);
    } else {
      found.lastFailure = found.lastBuild;
      found.failed.set(key, { reason: outcome.reason, at });
    }
  }

  return {
    target,
    peek: (id) => targets.get(id),
    drop(id) {
      targets.delete(id);
    },
    resolved(targetId, resolved) {
      target(targetId).resolution = resolved.ok
        ? { at: services.now(), commit: resolved.value.commit, ref: resolved.value.ref }
        : { at: services.now(), failure: resolved.error.code };
    },
    finished,
    refused(refusal) {
      const found = target(refusal.targetId);
      found.lastBuild = recordRefusal(services, refusal);
      found.lastFailure = found.lastBuild;
    },
  };
}
