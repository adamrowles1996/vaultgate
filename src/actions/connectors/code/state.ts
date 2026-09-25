/**
 * What vaultgate remembers about each code target between calls (ACT-108,
 * ACT-115), in memory only: nothing about a repository reaches the database
 * (13.13). The configured ref's last resolution, the snapshot it last
 * answered from, the last build and the last failure, and a short memory of
 * failed builds so a call does not refetch an archive that just failed. A
 * restart forgets it all, and the next call resolves and looks up afresh.
 */
import type { BuildOutcome, BuildRequest, Trigger } from './builds.ts';
import type { ResolvedReference } from './github.ts';
import type { Result } from '../../../result.ts';
import type { ActionError } from '../../errors.ts';
import type { ConnectorServices } from '../connector.ts';

export interface CurrentSnapshot {
  readonly key: string;
  readonly commit: string;
  readonly ref: string;
  readonly indexedAt: number;
  readonly fingerprint: string;
}

export interface Resolution {
  readonly at: number;
  readonly commit?: string;
  readonly ref?: string;
  readonly failure?: string;
}

export interface BuildRecord {
  readonly at: number;
  readonly commit: string;
  readonly ref: string;
  readonly trigger: Trigger;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface TargetState {
  resolution: Resolution | undefined;
  current: CurrentSnapshot | undefined;
  lastBuild: BuildRecord | undefined;
  lastFailure: BuildRecord | undefined;
  /**
  The ref each commit was resolved from, for the page.
  */
  readonly refs: Map<string, string>;
  readonly failed: Map<string, { readonly reason: string; readonly at: number }>;
}

export interface CodeState {
  target(id: string): TargetState;
  peek(id: string): TargetState | undefined;
  drop(id: string): void;
  resolved(targetId: string, resolved: Result<ResolvedReference, ActionError>): void;
  finished(request: BuildRequest, outcome: BuildOutcome, durationMs: number): void;
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
    refs: new Map(),
    failed: new Map(),
  };
}

/**
ACT-116: one event per build, with the counts or the reason; never a file name or content.
*/
function recordBuild(
  services: StateDependencies['services'],
  request: BuildRequest,
  outcome: BuildOutcome,
  durationMs: number,
): void {
  const counts = outcome.ok
    ? {
        files: outcome.meta.files,
        chunks: Object.values(outcome.meta.variants).reduce((sum, v) => sum + v.chunks, 0),
      }
    : { reason: outcome.reason };
  services.audit.record({
    category: 'actions',
    action: outcome.ok ? 'code_index_built' : 'code_index_failed',
    outcome: outcome.ok ? 'ok' : `error:${outcome.reason}`,
    durationMs,
    details: {
      target: request.targetName,
      connector: 'code',
      commit: request.commit,
      ref: request.ref,
      trigger: request.trigger,
      content: request.variants.map((variant) => variant.join('+')),
      ...counts,
    },
  });
}

function currentAfter(
  dependencies: StateDependencies,
  target: TargetState,
  request: BuildRequest,
  meta: { readonly created_at: number },
): CurrentSnapshot | undefined {
  const resolved = target.resolution?.commit;
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

export function createCodeState(dependencies: StateDependencies): CodeState {
  const { services } = dependencies;
  const targets = new Map<string, TargetState>();

  function target(id: string): TargetState {
    const found = targets.get(id) ?? emptyTarget();
    targets.set(id, found);
    return found;
  }

  function finished(request: BuildRequest, outcome: BuildOutcome, durationMs: number): void {
    const found = target(request.targetId);
    const at = services.now();
    const { commit, ref, trigger } = request;
    const reason = outcome.ok ? {} : { reason: outcome.reason };
    found.lastBuild = { at, commit, ref, trigger, durationMs, ...reason };
    found.refs.set(commit, ref);
    if (outcome.ok) {
      found.failed.delete(dependencies.keyOf(request));
      found.current = currentAfter(dependencies, found, request, outcome.meta);
    } else {
      found.lastFailure = found.lastBuild;
      found.failed.set(dependencies.keyOf(request), { reason: outcome.reason, at });
    }
    recordBuild(services, request, outcome, durationMs);
  }

  return {
    target,
    peek: (id) => targets.get(id),
    drop(id) {
      targets.delete(id);
    },
    resolved(targetId, resolved) {
      const found = target(targetId);
      found.resolution = resolved.ok
        ? { at: services.now(), commit: resolved.value.commit, ref: resolved.value.ref }
        : { at: services.now(), failure: resolved.error.code };
      if (resolved.ok) {
        found.refs.set(resolved.value.commit, resolved.value.ref);
      }
    },
    finished,
  };
}
