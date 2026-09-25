/**
 * The operator's side of the code connector (ACT-108, ACT-109, ACT-115):
 * building when a target is saved or the operator presses Rebuild index,
 * deleting a target's snapshots with it, reconciling the sidecar's snapshots
 * with the stored targets, and the status the target page draws. None of it
 * runs inside a call; each build borrows the target's credential from the
 * engine for as long as it runs.
 */
import { documentsOf, githubAccess, type Builds, type BuildRequest } from './builds.ts';
import { resolveReference } from './github.ts';
import { type CodeDocuments, extractionFingerprint, parseSnapshotKey } from './keys.ts';
import { parseReference } from './references.ts';
import { normaliseContent } from './schemas.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, TargetAccess } from '../connector.ts';
import type { SnapshotList, SnapshotMeta } from './sidecar-schemas.ts';
import type { SidecarClient } from './sidecar.ts';
import type { BuildRecord, CodeState, Resolution, TargetState } from './state.ts';

export interface ControlDependencies {
  readonly sidecar: SidecarClient;
  readonly fetch: PinnedFetch;
  readonly services: ConnectorServices;
  readonly userAgent: string;
  readonly builds: Builds;
  readonly state: CodeState;
}

export interface SnapshotStatus extends SnapshotMeta {
  readonly ref: string | undefined;
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
  ACT-108: builds the configured ref now; `isReset` deletes every snapshot of the target first.
  */
  refresh(targetId: string, trigger: 'save' | 'operator', isReset: boolean): Promise<void>;
  forgetTarget(targetId: string): Promise<void>;
  reconcile(): Promise<void>;
}

const SIDECAR_TIMEOUT_MS = 10_000;

function signal(): AbortSignal {
  return AbortSignal.timeout(SIDECAR_TIMEOUT_MS);
}

async function forgetTarget(dependencies: ControlDependencies, targetId: string): Promise<void> {
  dependencies.state.drop(targetId);
  await dependencies.sidecar.deleteOwner(targetId, signal());
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
  const targetId = access.support.target.id;
  const resolved = await resolveReference(
    githubAccess(access, dependencies, signal()),
    documents.destination.repository,
    parseReference(documents.destination.ref) ?? { kind: 'default' },
  );
  dependencies.state.resolved(targetId, resolved);
  const request: BuildRequest = {
    targetId,
    targetName: access.support.target.name,
    documents,
    commit: resolved.ok ? resolved.value.commit : '',
    ref: resolved.ok ? resolved.value.ref : (documents.destination.ref ?? ''),
    trigger,
    variants: [normaliseContent(documents.policy.content)],
    configured: true,
  };
  if (!resolved.ok) {
    dependencies.state.finished(request, { ok: false, reason: resolved.error.code }, 0);
    return;
  }
  dependencies.state.target(targetId).failed.clear();
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
  await dependencies.services.withTarget(targetId, async (access) => {
    await buildConfigured(dependencies, access, trigger);
  });
}

/**
ACT-109: snapshots of deleted targets, and of extraction policies since changed, go.
*/
async function reconcile(dependencies: ControlDependencies): Promise<void> {
  const listed = await dependencies.sidecar.list(signal());
  if (!listed.ok) {
    return;
  }
  const fingerprints = new Map(
    dependencies.services
      .targets()
      .map((target) => [
        target.id,
        target.documents === undefined
          ? undefined
          : extractionFingerprint(target.documents as CodeDocuments),
      ]),
  );
  const owners = new Set<string>();
  for (const snapshot of listed.value.snapshots) {
    if (fingerprints.has(snapshot.owner)) {
      if (parseSnapshotKey(snapshot.key)?.fingerprint !== fingerprints.get(snapshot.owner)) {
        await dependencies.sidecar.deleteSnapshot(snapshot.key, signal());
      }
    } else {
      owners.add(snapshot.owner);
    }
  }
  for (const owner of owners) {
    await dependencies.sidecar.deleteOwner(owner, signal());
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
    .map((snapshot) => ({
      ...snapshot,
      ref: target?.refs.get(snapshot.commit),
      current: target?.current?.key === snapshot.key,
    }));
}

async function status(
  dependencies: ControlDependencies,
  targetId: string,
): Promise<CodeIndexStatus> {
  const listed = await dependencies.sidecar.list(signal());
  const target = dependencies.state.peek(targetId);
  return {
    reachable: listed.ok,
    snapshots: listed.ok ? snapshotsOf(listed.value, targetId, target) : [],
    building: listed.ok && listed.value.building.some((entry) => entry.owner === targetId),
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
