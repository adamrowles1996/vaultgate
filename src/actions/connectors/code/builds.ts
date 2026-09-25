/**
 * Building a snapshot (ACT-105, ACT-108, ACT-116): the commit's archive is
 * opened on GitHub and streamed to the sidecar's build as it arrives, cut at
 * `max_archive_bytes`; one build runs per key at a time and a second trigger
 * joins it. A build holds its own credential for as long as it runs (the
 * engine lends one through `withTarget` and disposes of it after), so it can
 * outlive the call that started it. Every build ends in one audit event.
 */
import { type GitHubAccess, openArchive } from './github.ts';
import { extractionFingerprint, snapshotKey } from './keys.ts';
import { GITHUB_API_HOST, GITHUB_ARCHIVE_HOST } from './schemas.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, RunContext, TargetAccess } from '../connector.ts';
import type { CodeDocuments } from './keys.ts';
import type { ContentType } from './schemas.ts';
import type { BuildSpec, SnapshotMeta } from './sidecar-schemas.ts';
import type { SidecarClient } from './sidecar.ts';

export type Trigger = 'save' | 'operator' | 'call';

export interface BuildRequest {
  readonly targetId: string;
  readonly targetName: string;
  readonly documents: CodeDocuments;
  readonly commit: string;
  /**
  What the commit was resolved from, for the page (ACT-115).
  */
  readonly ref: string;
  readonly trigger: Trigger;
  readonly variants: readonly (readonly ContentType[])[];
  /**
  Whether the commit is the configured ref's, so a success makes it the one calls answer from.
  */
  readonly configured: boolean;
}

export type BuildOutcome =
  | { readonly ok: true; readonly meta: SnapshotMeta }
  | { readonly ok: false; readonly reason: string };

export interface BuildsDependencies {
  readonly sidecar: SidecarClient;
  readonly fetch: PinnedFetch;
  readonly services: ConnectorServices;
  readonly userAgent: string;
  /**
  Told of every build's end, once, whichever trigger started it.
  */
  readonly finished: (request: BuildRequest, outcome: BuildOutcome, durationMs: number) => void;
}

export interface Builds {
  /**
  Builds with a credential the caller holds for the whole build.
  */
  run(access: TargetAccess, request: BuildRequest): Promise<BuildOutcome>;
  /**
  Builds with a credential of its own, fetched now; a running build of the same key is joined.
  */
  start(request: BuildRequest): Promise<BuildOutcome>;
}

type Access = TargetAccess | RunContext<unknown, unknown, unknown>;

/**
The documents a call or a build holds, as the code connector reads them.
*/
export function documentsOf(access: Access): CodeDocuments {
  return {
    destination: access.destination,
    credential: access.credential,
    policy: access.policy,
  } as CodeDocuments;
}

/**
The GitHub access of a call or a build: both pinned addresses, the token if any, the capture.
*/
export function githubAccess(
  access: Access,
  dependencies: { readonly fetch: PinnedFetch; readonly userAgent: string },
  signal: AbortSignal,
): GitHubAccess {
  const address = (host: string): string =>
    access.pinned.find((endpoint) => endpoint.host === host)?.address ?? '';
  const tokenField = documentsOf(access).credential.token_field;
  const token = tokenField === null ? undefined : access.injected.value(tokenField);
  return {
    fetch: dependencies.fetch,
    apiAddress: address(GITHUB_API_HOST),
    archiveAddress: address(GITHUB_ARCHIVE_HOST),
    token: token?.toString('utf8'),
    signal,
    userAgent: dependencies.userAgent,
    capture: (field, value) => {
      access.support.capture(field, value);
    },
  };
}

class ArchiveTooLarge extends Error {
  constructor() {
    super('archive_too_large');
    this.name = 'ArchiveTooLarge';
  }
}

/**
ACT-105: the archive as it arrives, failing the moment it passes `limit` bytes.
*/
async function* capped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  overflowed: () => void,
): AsyncIterable<Uint8Array> {
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) {
      overflowed();
      throw new ArchiveTooLarge();
    }
    yield chunk;
  }
}

/**
Download time allowed beyond the sidecar's own build timeout.
*/
const DOWNLOAD_ALLOWANCE_MS = 300_000;
const MS_PER_SECOND = 1000;

export function keyOf(request: Pick<BuildRequest, 'targetId' | 'documents' | 'commit'>): string {
  return snapshotKey(request.targetId, extractionFingerprint(request.documents), request.commit);
}

function buildSpec(request: BuildRequest): BuildSpec {
  const { policy } = request.documents;
  return {
    owner: request.targetId,
    commit: request.commit,
    include: policy.include,
    exclude: policy.exclude,
    max_archive_bytes: policy.max_archive_bytes,
    max_files: policy.max_files,
    max_total_bytes: policy.max_total_bytes,
    max_file_bytes: policy.max_file_bytes,
    build_timeout_s: policy.build_timeout_s,
    variants: request.variants,
  };
}

async function stream(
  dependencies: BuildsDependencies,
  access: TargetAccess,
  request: BuildRequest,
  signal: AbortSignal,
): Promise<BuildOutcome> {
  const archive = await openArchive(
    githubAccess(access, dependencies, signal),
    request.documents.destination.repository,
    request.commit,
  );
  if (!archive.ok) {
    return { ok: false, reason: archive.error.code };
  }
  // Read after the build: the stream is cut inside the upload, which the
  // sidecar client then reports as an unreachable sidecar.
  const overflow = { hasHappened: false };
  const body = capped(archive.value, request.documents.policy.max_archive_bytes, () => {
    overflow.hasHappened = true;
  });
  const built = await dependencies.sidecar.build(keyOf(request), buildSpec(request), body, signal);
  if (overflow.hasHappened) {
    return { ok: false, reason: 'archive_too_large' };
  }
  return built.ok ? { ok: true, meta: built.value } : { ok: false, reason: built.error.code };
}

/**
One build under a timeout of its own: the sidecar's build time plus the download's.
*/
async function download(
  dependencies: BuildsDependencies,
  access: TargetAccess,
  request: BuildRequest,
): Promise<BuildOutcome> {
  const controller = new AbortController();
  const cancel = dependencies.services.schedule(
    () => {
      controller.abort();
    },
    request.documents.policy.build_timeout_s * MS_PER_SECOND + DOWNLOAD_ALLOWANCE_MS,
  );
  try {
    return await stream(dependencies, access, request, controller.signal);
  } catch (error) {
    if (error instanceof ArchiveTooLarge) {
      return { ok: false, reason: 'archive_too_large' };
    }
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'index_unavailable' };
  } finally {
    cancel();
  }
}

/**
 * ACT-108: a build started with its own credential, refused when the target
 * changed under it so that no snapshot is keyed by documents it was not built from.
 */
async function withOwnCredential(
  dependencies: BuildsDependencies,
  request: BuildRequest,
): Promise<BuildOutcome> {
  const expected = extractionFingerprint(request.documents);
  const outcome = await dependencies.services.withTarget(request.targetId, async (access) =>
    extractionFingerprint(documentsOf(access)) === expected
      ? download(dependencies, access, request)
      : { ok: false as const, reason: 'target_changed' },
  );
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.error.code };
}

export function createBuilds(dependencies: BuildsDependencies): Builds {
  const running = new Map<string, Promise<BuildOutcome>>();

  async function once(request: BuildRequest, build: () => Promise<BuildOutcome>) {
    const key = keyOf(request);
    const current = running.get(key);
    if (current !== undefined) {
      return current;
    }
    const startedAt = dependencies.services.now();
    const promise = (async () => {
      const outcome = await build();
      running.delete(key);
      dependencies.finished(request, outcome, dependencies.services.now() - startedAt);
      return outcome;
    })();
    running.set(key, promise);
    return promise;
  }

  return {
    run: (access, request) => once(request, () => download(dependencies, access, request)),
    start: (request) => once(request, () => withOwnCredential(dependencies, request)),
  };
}
