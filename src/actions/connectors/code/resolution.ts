/**
 * The commit a call reads (ACT-104, ACT-108): a ref the call names is
 * resolved on every call, and the configured ref at most once per
 * `refresh_interval_s`. A failed resolution of the configured ref while there
 * is a snapshot to answer from is recorded on the page and in the audit trail
 * once per resolution, and the call answers from that snapshot.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { documentsOf, githubAccess } from './builds.ts';
import { resolveReference, type ResolvedReference } from './github.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { ConnectorServices, RunContext } from '../connector.ts';
import type { ContentType } from './schemas.ts';
import type { CodeState } from './state.ts';

type Context = RunContext<unknown, unknown, unknown>;

export interface ResolutionDependencies {
  readonly fetch: PinnedFetch;
  readonly services: ConnectorServices;
  readonly userAgent: string;
  readonly state: CodeState;
}

export interface ResolutionRequest {
  readonly context: Context;
  readonly ref: string | undefined;
  readonly content: readonly ContentType[];
}

const MS_PER_SECOND = 1000;

export function isFresh(services: ConnectorServices, at: number, context: Context): boolean {
  return services.now() - at < documentsOf(context).policy.refresh_interval_s * MS_PER_SECOND;
}

/**
 * ACT-104, ACT-108: the commit a ref names. A ref the call names is resolved
 * every time (a SHA needs no request); the configured one comes from the
 * last resolution while it is fresh, and so does its failure while there is
 * a snapshot to answer from instead, which is recorded once per resolution.
 */
export async function resolveFor(
  dependencies: ResolutionDependencies,
  request: ResolutionRequest,
  hasSnapshot: boolean,
): Promise<Result<ResolvedReference, ActionError>> {
  const { context } = request;
  const { destination } = documentsOf(context);
  const github = githubAccess(context, dependencies, context.signal);
  if (request.ref !== undefined) {
    return resolveReference(github, destination.repository, request.ref);
  }
  const { id: targetId, name: targetName } = context.support.target;
  const cached = dependencies.state.target(targetId).resolution;
  if (cached !== undefined && isFresh(dependencies.services, cached.at, context)) {
    if ('commit' in cached) {
      return ok({ commit: cached.commit, ref: cached.ref });
    }
    if (hasSnapshot) {
      return fail(new ActionError(cached.failure));
    }
  }
  const resolved = await resolveReference(github, destination.repository, destination.ref);
  dependencies.state.resolved(targetId, resolved);
  if (hasSnapshot && !resolved.ok) {
    const { content } = request;
    const reason = resolved.error.code;
    dependencies.state.refused({ targetId, targetName, trigger: 'call', content, reason });
  }
  return resolved;
}
