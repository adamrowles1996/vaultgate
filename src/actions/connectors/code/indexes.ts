/**
 * Which snapshot a call reads (ACT-108, ACT-112). The ref is resolved (the
 * configured one at most once per `refresh_interval_s`), the snapshot of that
 * commit is looked up, and one that does not exist is built while the call
 * waits, up to `build_wait_s`, as `semble` indexes a repository on its first
 * call. A configured ref that has moved is answered from the previous
 * commit's snapshot with `stale: true` while the new one builds, and a
 * configured ref that cannot be resolved is answered from it too, and
 * recorded.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { BUILD_RETRY_AFTER_S } from './build-slots.ts';
import { BUSY, documentsOf, keyOf, type Builds, type BuildRequest } from './builds.ts';
import { extractionFingerprint } from './keys.ts';
import { refusalError } from './refusals.ts';
import { isFresh, resolveFor } from './resolution.ts';
import { normaliseContent } from './schemas.ts';
import { background, until } from './timing.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, RunContext } from '../connector.ts';
import type { ResolvedReference } from './github.ts';
import type { ContentType } from './schemas.ts';
import type { SidecarClient } from './sidecar.ts';
import type { CodeState, CurrentSnapshot } from './state.ts';

type Context = RunContext<unknown, unknown, unknown>;

export interface PrepareRequest {
  readonly context: Context;
  readonly ref: string | undefined;
  readonly content: readonly ContentType[];
  /**
  When the call stops waiting for a build (ms since the epoch).
  */
  readonly deadline: number;
}

/**
One repository of a call, ready to be read.
*/
export interface Prepared {
  readonly targetId: string;
  readonly key: string;
  readonly label: string;
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly stale: boolean;
  readonly indexedAt: number;
}

export interface IndexesDependencies {
  readonly sidecar: SidecarClient;
  readonly fetch: PinnedFetch;
  readonly services: ConnectorServices;
  readonly userAgent: string;
  readonly builds: Builds;
  readonly state: CodeState;
}

export interface Indexes {
  prepare(request: PrepareRequest): Promise<Result<Prepared, ActionError>>;
  /**
  A snapshot the sidecar no longer has: forget it so the next preparation builds it again.
  */
  forget(targetId: string, key: string): void;
}

function notReady(repo: string, state: 'building' | 'failed', reason?: string): ActionError {
  return new ActionError('index_not_ready', {
    state,
    repo,
    ...(reason !== undefined && { reason }),
  });
}

/**
ACT-104, ACT-112: what a call answers for a build that ended without a snapshot.
*/
function failedBuild(label: string, reason: string): ActionError {
  return reason === 'index_unavailable' || reason === 'ref_not_found'
    ? new ActionError(reason)
    : notReady(label, 'failed', reason);
}

/**
 * ACT-107, ACT-108: the indexes a call's build makes. A build of the
 * configured ref makes the policy's whole `content` beside the call's own
 * selection, as a save does, so the next call without a `content` finds its
 * index built rather than building it on demand; a ref the call named makes
 * the call's selection only.
 */
function variantsFor(
  request: PrepareRequest,
  isConfigured: boolean,
): readonly (readonly ContentType[])[] {
  const whole = normaliseContent(documentsOf(request.context).policy.content);
  const isWhole = whole.join('+') === request.content.join('+');
  return isConfigured && !isWhole ? [request.content, whole] : [request.content];
}

function buildRequestFor(
  request: PrepareRequest,
  resolved: ResolvedReference,
  isConfigured: boolean,
): BuildRequest {
  return {
    targetId: request.context.support.target.id,
    targetName: request.context.support.target.name,
    documents: documentsOf(request.context),
    commit: resolved.commit,
    ref: resolved.ref,
    trigger: 'call',
    variants: variantsFor(request, isConfigured),
    configured: isConfigured,
  };
}

/**
A build of `key` that failed within the refresh interval, so it is not tried again yet.
*/
function recentFailure(
  dependencies: IndexesDependencies,
  context: Context,
  key: string,
): string | undefined {
  const failed = dependencies.state.target(context.support.target.id).failed.get(key);
  return failed !== undefined && isFresh(dependencies.services, failed.at, context)
    ? failed.reason
    : undefined;
}

/**
ACT-112: the snapshot's build time once it exists, waiting for its build up to the deadline.
*/
async function ensureSnapshot(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
  resolved: ResolvedReference,
  key: string,
): Promise<Result<number, ActionError>> {
  const { context } = request;
  const label = context.support.target.name;
  const failure = recentFailure(dependencies, context, key);
  if (failure !== undefined) {
    return fail(failedBuild(label, failure));
  }
  const status = await dependencies.sidecar.status(key, context.signal);
  if (!status.ok) {
    return fail(refusalError(status.error, label));
  }
  if (status.value.state === 'ready') {
    return ok(status.value.meta.created_at);
  }
  const building = dependencies.builds.start(
    buildRequestFor(request, resolved, request.ref === undefined),
  );
  if (building === BUSY) {
    // T46: the target or the process builds as many refs as calls may start.
    return fail(
      new ActionError('rate_limited', { retry_after_s: BUILD_RETRY_AFTER_S, repo: label }),
    );
  }
  const outcome = await until(dependencies.services, building, request.deadline);
  if (outcome === 'timeout') {
    return fail(notReady(label, 'building'));
  }
  return outcome.ok ? ok(outcome.meta.created_at) : fail(failedBuild(label, outcome.reason));
}

function prepared(
  request: PrepareRequest,
  snapshot: Omit<CurrentSnapshot, 'fingerprint'>,
  isStale: boolean,
): Prepared {
  return {
    targetId: request.context.support.target.id,
    key: snapshot.key,
    label: request.context.support.target.name,
    repository: documentsOf(request.context).destination.repository,
    commit: snapshot.commit,
    ref: snapshot.ref,
    stale: isStale,
    indexedAt: snapshot.indexedAt,
  };
}

/**
ACT-108: the configured ref moved; its new commit builds in the background unless it just failed.
*/
function buildMoved(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
  resolved: ResolvedReference,
  key: string,
): void {
  if (recentFailure(dependencies, request.context, key) !== undefined) {
    return;
  }
  const moved = buildRequestFor(request, resolved, true);
  background(dependencies.services, 'a build of a moved ref', async () =>
    dependencies.builds.start(moved),
  );
}

async function prepare(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
): Promise<Result<Prepared, ActionError>> {
  const { context } = request;
  const documents = documentsOf(context);
  const targetId = context.support.target.id;
  const target = dependencies.state.target(targetId);
  const fingerprint = extractionFingerprint(documents);
  const current =
    request.ref === undefined && target.current?.fingerprint === fingerprint
      ? target.current
      : undefined;
  const resolved = await resolveFor(dependencies, request, current !== undefined);
  if (!resolved.ok) {
    // ACT-108: a failed resolution with a snapshot to answer from never fails the call.
    return current === undefined ? resolved : ok(prepared(request, current, false));
  }
  const { commit, ref } = resolved.value;
  const key = keyOf({ targetId, documents, commit });
  if (current !== undefined && current.commit !== commit) {
    buildMoved(dependencies, request, resolved.value, key);
    return ok(prepared(request, current, true));
  }
  const built = await ensureSnapshot(dependencies, request, resolved.value, key);
  if (!built.ok) {
    return built;
  }
  const snapshot = { key, commit, ref, indexedAt: built.value };
  if (request.ref === undefined) {
    target.current = { ...snapshot, fingerprint };
  }
  return ok(prepared(request, snapshot, false));
}

export function createIndexes(dependencies: IndexesDependencies): Indexes {
  return {
    prepare: (request) => prepare(dependencies, request),
    forget(targetId, key) {
      const target = dependencies.state.target(targetId);
      if (target.current?.key === key) {
        target.current = undefined;
      }
    },
  };
}
