/**
 * The operator's side of the code connector (ACT-108, ACT-109, ACT-115):
 * building when a target is saved or the operator presses Rebuild index,
 * deleting a target's snapshots with it, reconciling the sidecar's snapshots
 * with the stored targets, and the status the target page draws. None of it
 * runs inside a call; each build borrows the target's credential from the
 * engine for as long as it runs, and a build that could not start is
 * recorded on the page and in the audit trail like one that failed.
 */
import { documentsOf, githubAccess, type Builds, type BuildRequest } from './builds.ts';
import { resolveReference } from './github.ts';
import { type CodeDocuments, extractionFingerprint, parseSnapshotKey } from './keys.ts';
import { normaliseContent } from './schemas.ts';
import { withDeadline } from './timing.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, TargetAccess } from '../connector.ts';
import type { SnapshotList, SnapshotMeta } from './sidecar-schemas.ts';
import type { SidecarClient } from './sidecar.ts';
import type { BuildRecord, CodeState, Resolution, SnapshotNote, TargetState } from './state.ts';

export interface ControlDependencies {
  readonly sidecar: SidecarClient;
  readonly fetch: PinnedFetch;
  readonly services: ConnectorServices;
  readonly userAgent: string;
  readonly builds: Builds;
  readonly state: CodeState;
}

export interface SnapshotStatus extends SnapshotMeta {
  /**
  The ref and trigger it was built for, when this process built it.
  */
  readonly ref: string | undefined;
  readonly trigger: SnapshotNote['trigger'] | undefined;
  /**
  Whether calls without a `ref` answer from it.
  */
  readonly current: boolean;
}

/**
ACT-115: what the target page shows about one code target's indexes.
*/
export interface CodeIndexStatus {
  readonly reachable: boolean;
  readonly snapshots: readonly SnapshotStatus[];
  readonly building: boolean;
  readonly resolution: Resolution | undefined;
  readonly lastBuild: BuildRecord | undefined;
  readonly lastFailure: BuildRecord | undefined;
}

export interface CodeControl {
  status(targetId: string): Promise<CodeIndexStatus>;
  /**
   * ACT-108: builds the configured ref now (trigger `save`, or `operator` for
   * Rebuild index); `isReset` deletes every snapshot of the target first, as
   * Rebuild index always asks.
   */
  refresh(targetId: string, trigger: 'save' | 'operator', isReset: boolean): Promise<void>;
  forgetTarget(targetId: string): Promise<void>;
  reconcile(): Promise<void>;
}

const SIDECAR_TIMEOUT_MS = 10_000;
const RESOLUTION_TIMEOUT_MS = 30_000;

async function forgetTarget(dependencies: ControlDependencies, targetId: string): Promise<void> {
  const { services, sidecar, state } = dependencies;
  state.drop(targetId);
  const deleted = await withDeadline(services, SIDECAR_TIMEOUT_MS, (signal) =>
    sidecar.deleteOwner(targetId, signal),
  );
  if (!deleted.ok) {
    services.logger.warn(
      { target: targetId, reason: deleted.error.code },
      'code snapshots not deleted yet; the next reconciliation deletes them',
    );
  }
}

/**
The configured ref resolved and built, with the credential the engine lent for it.
*/
async function buildConfigured(
  dependencies: ControlDependencies,
  access: TargetAccess,
  trigger: 'save' | 'operator',
): Promise<void> {
  const documents: CodeDocuments = documentsOf(access);
  const { id: targetId, name: targetName } = access.support.target;
  const content = normaliseContent(documents.policy.content);
  const resolved = await withDeadline(dependencies.services, RESOLUTION_TIMEOUT_MS, (signal) =>
    resolveReference(
      githubAccess(access, dependencies, signal),
      documents.destination.repository,
      documents.destination.ref,
    ),
  );
  dependencies.state.resolved(targetId, resolved);
  if (!resolved.ok) {
    const reason = resolved.error.code;
    dependencies.state.refused({ targetId, targetName, trigger, content, reason });
    return;
  }
  dependencies.state.target(targetId).failed.clear();
  const request: BuildRequest = {
    targetId,
    targetName,
    documents,
    commit: resolved.value.commit,
    ref: resolved.value.ref,
    trigger,
    variants: [content],
    configured: true,
  };
  await dependencies.builds.run(access, request);
}

async function refresh(
  dependencies: ControlDependencies,
  targetId: string,
  trigger: 'save' | 'operator',
  isReset: boolean,
): Promise<void> {
  if (isReset) {
    await forgetTarget(dependencies, targetId);
  }
  const outcome = await dependencies.services.withTarget(targetId, async (access) => {
    await buildConfigured(dependencies, access, trigger);
  });
  const stored = dependencies.services.targets().find((target) => target.id === targetId);
  if (stored === undefined || outcome.ok) {
    return;
  }
  const policy = (stored.documents as CodeDocuments | undefined)?.policy;
  dependencies.state.refused({
    targetId,
    targetName: stored.name,
    trigger,
    content: policy === undefined ? [] : normaliseContent(policy.content),
    reason: outcome.error.code,
  });
}

/**
ACT-109: snapshots of deleted targets, and of extraction policies since changed, go.
*/
async function reconcile(dependencies: ControlDependencies): Promise<void> {
  const { services, sidecar } = dependencies;
  const listed = await withDeadline(services, SIDECAR_TIMEOUT_MS, (signal) => sidecar.list(signal));
  if (!listed.ok) {
    return;
  }
  const fingerprints = new Map(
    services
      .targets()
      .map((target) => [
        target.id,
        target.documents === undefined
          ? undefined
          : extractionFingerprint(target.documents as CodeDocuments),
      ]),
  );
  const owners = new Set<string>();
  const stale: string[] = [];
  for (const snapshot of listed.value.snapshots) {
    if (!fingerprints.has(snapshot.owner)) {
      owners.add(snapshot.owner);
    } else if (parseSnapshotKey(snapshot.key)?.fingerprint !== fingerprints.get(snapshot.owner)) {
      stale.push(snapshot.key);
    }
  }
  for (const key of stale) {
    await withDeadline(services, SIDECAR_TIMEOUT_MS, (signal) =>
      sidecar.deleteSnapshot(key, signal),
    );
  }
  for (const owner of owners) {
    await withDeadline(services, SIDECAR_TIMEOUT_MS, (signal) =>
      sidecar.deleteOwner(owner, signal),
    );
  }
}

function snapshotsOf(
  listed: SnapshotList,
  targetId: string,
  target: TargetState | undefined,
): readonly SnapshotStatus[] {
  return listed.snapshots
    .filter((snapshot) => snapshot.owner === targetId)
    .toSorted((left, right) => right.created_at - left.created_at)
    .map((snapshot) => {
      const note = target?.notes.get(snapshot.key);
      return {
        ...snapshot,
        ref: note?.ref,
        trigger: note?.trigger,
        current: target?.current?.key === snapshot.key,
      };
    });
}

async function status(
  dependencies: ControlDependencies,
  targetId: string,
): Promise<CodeIndexStatus> {
  const { services, sidecar, state, builds } = dependencies;
  const listed = await withDeadline(services, SIDECAR_TIMEOUT_MS, (signal) => sidecar.list(signal));
  const target = state.peek(targetId);
  const isSidecarBuilding =
    listed.ok && listed.value.building.some((entry) => entry.owner === targetId);
  return {
    reachable: listed.ok,
    snapshots: listed.ok ? snapshotsOf(listed.value, targetId, target) : [],
    building: isSidecarBuilding || builds.isBuilding(targetId),
    resolution: target?.resolution,
    lastBuild: target?.lastBuild,
    lastFailure: target?.lastFailure,
  };
}

export function createControl(dependencies: ControlDependencies): CodeControl {
  return {
    status: (targetId) => status(dependencies, targetId),
    refresh: (targetId, trigger, isReset) => refresh(dependencies, targetId, trigger, isReset),
    forgetTarget: (targetId) => forgetTarget(dependencies, targetId),
    reconcile: () => reconcile(dependencies),
  };
}
