/**
 * Which snapshot a call reads (ACT-108, ACT-112). The ref is resolved (the
 * configured one at most once per `refresh_interval_s`), the snapshot of that
 * commit is looked up, and one that does not exist is built while the call
 * waits, up to `build_wait_s`, as `semble` indexes a repository on its first
 * call. A configured ref that has moved is answered from the previous
 * commit's snapshot with `stale: true` while the new one builds.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { documentsOf, githubAccess, keyOf, type Builds, type BuildRequest } from './builds.ts';
import { resolveReference, type ResolvedReference } from './github.ts';
import { extractionFingerprint } from './keys.ts';
import { parseReference } from './references.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, RunContext } from '../connector.ts';
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

const MS_PER_SECOND = 1000;

function notReady(repo: string, state: 'building' | 'failed', reason?: string): ActionError {
  return new ActionError('index_not_ready', {
    state,
    repo,
    ...(reason !== undefined && { reason }),
  });
}

function noop(): void {
  // Replaced by the timer's own cancel before it can be called.
}

/**
Resolves `wait`, or `'timeout'` at `deadline`, whichever is first.
*/
async function until<T>(
  services: ConnectorServices,
  wait: Promise<T>,
  deadline: number,
): Promise<T | 'timeout'> {
  let cancel = noop;
  const timedOut = new Promise<'timeout'>((resolve) => {
    cancel = services.schedule(
      () => {
        resolve('timeout');
      },
      Math.max(0, deadline - services.now()),
    );
  });
  try {
    return await Promise.race([wait, timedOut]);
  } finally {
    cancel();
  }
}

function isFresh(services: ConnectorServices, at: number, intervalS: number): boolean {
  return services.now() - at < intervalS * MS_PER_SECOND;
}

/**
ACT-104: the commit a ref names; the configured one from the cache while it is fresh (ACT-108).
*/
async function resolveFor(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
): Promise<Result<ResolvedReference, ActionError>> {
  const { context } = request;
  const { policy, destination } = documentsOf(context);
  const github = githubAccess(context, dependencies, context.signal);
  if (request.ref !== undefined) {
    const spec = parseReference(request.ref) ?? { kind: 'default' };
    return resolveReference(github, destination.repository, spec);
  }
  const cached = dependencies.state.target(context.support.target.id).resolution;
  if (
    cached?.commit !== undefined &&
    isFresh(dependencies.services, cached.at, policy.refresh_interval_s)
  ) {
    return ok({ commit: cached.commit, ref: cached.ref ?? cached.commit });
  }
  const spec = parseReference(destination.ref) ?? { kind: 'default' };
  const resolved = await resolveReference(github, destination.repository, spec);
  dependencies.state.resolved(context.support.target.id, resolved);
  return resolved;
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
    variants: [request.content],
    configured: isConfigured,
  };
}

/**
ACT-112: the snapshot's build time once it exists, waiting for its build if need be.
*/
async function ensureSnapshot(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
  resolved: ResolvedReference,
  key: string,
): Promise<Result<number, ActionError>> {
  const { context } = request;
  const label = context.support.target.name;
  const failed = dependencies.state.target(context.support.target.id).failed.get(key);
  const interval = documentsOf(context).policy.refresh_interval_s;
  if (failed !== undefined && isFresh(dependencies.services, failed.at, interval)) {
    return fail(notReady(label, 'failed', failed.reason));
  }
  const status = await dependencies.sidecar.status(key, context.signal);
  if (status.ok && status.value.state === 'ready') {
    return ok(status.value.meta.created_at);
  }
  if (!status.ok && status.error instanceof ActionError) {
    return fail(status.error);
  }
  const building = dependencies.builds.start(
    buildRequestFor(request, resolved, request.ref === undefined),
  );
  const outcome = await until(dependencies.services, building, request.deadline);
  if (outcome === 'timeout') {
    return fail(notReady(label, 'building'));
  }
  return outcome.ok ? ok(outcome.meta.created_at) : fail(notReady(label, 'failed', outcome.reason));
}

function fromCurrent(
  request: PrepareRequest,
  current: CurrentSnapshot,
  isStale: boolean,
): Prepared {
  return {
    key: current.key,
    label: request.context.support.target.name,
    repository: documentsOf(request.context).destination.repository,
    commit: current.commit,
    ref: current.ref,
    stale: isStale,
    indexedAt: current.indexedAt,
  };
}

async function prepare(
  dependencies: IndexesDependencies,
  request: PrepareRequest,
): Promise<Result<Prepared, ActionError>> {
  const { context } = request;
  const documents = documentsOf(context);
  const target = dependencies.state.target(context.support.target.id);
  const fingerprint = extractionFingerprint(documents);
  const current =
    request.ref === undefined && target.current?.fingerprint === fingerprint
      ? target.current
      : undefined;
  const resolved = await resolveFor(dependencies, request);
  if (!resolved.ok) {
    // ACT-108: a failed resolution with a snapshot to answer from never fails the call.
    return current === undefined ? resolved : ok(fromCurrent(request, current, false));
  }
  if (current !== undefined && current.commit !== resolved.value.commit) {
    void dependencies.builds.start(buildRequestFor(request, resolved.value, true));
    return ok(fromCurrent(request, current, true));
  }
  const key = keyOf({
    targetId: context.support.target.id,
    documents,
    commit: resolved.value.commit,
  });
  const built = await ensureSnapshot(dependencies, request, resolved.value, key);
  if (!built.ok) {
    return built;
  }
  const snapshot = {
    key,
    commit: resolved.value.commit,
    ref: resolved.value.ref,
    indexedAt: built.value,
  };
  if (request.ref === undefined) {
    target.current = { ...snapshot, fingerprint };
  }
  return ok({
    ...snapshot,
    label: context.support.target.name,
    repository: documents.destination.repository,
    stale: false,
  });
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
