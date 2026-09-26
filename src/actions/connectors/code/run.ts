/**
 * One code call over one or more repositories (ACT-110 to ACT-112): every
 * repository's snapshot is prepared at once (resolved, looked up, built
 * while the call waits), then the sidecar answers the search, related query
 * or read. A snapshot the sidecar has since evicted is prepared once more.
 * Results keep `semble`'s fields; a search result that would pass the output
 * cap loses results from the end (ACT-52).
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { contentOf, isRead, isRelated, isSearch, sharedContent, topKFor } from './authorize.ts';
import { documentsOf } from './builds.ts';
import { readFile } from './read.ts';
import { refusalError } from './refusals.ts';
import { SidecarRefusal } from './sidecar.ts';
import { type Clock, withDeadline } from './timing.ts';

import type { ConnectorOutput, RunContext } from '../connector.ts';
import type { Indexes, Prepared } from './indexes.ts';
import type { ContentType } from './schemas.ts';
import type { SidecarResult } from './sidecar-schemas.ts';
import type { SidecarClient, SidecarOutcome } from './sidecar.ts';
import type { CodeOperation } from './tools.ts';

type Context = RunContext<unknown, unknown, unknown>;

export interface RunDependencies {
  readonly sidecar: SidecarClient;
  readonly indexes: Indexes;
  readonly clock: Clock;
}

/**
One call: its contexts, the first of them, the operation and the content every policy allows.
*/
interface Call {
  readonly contexts: readonly [Context, ...Context[]];
  readonly operation: CodeOperation;
  readonly content: readonly ContentType[];
  /**
  When the wait for builds ends (ms since the epoch), for both attempts.
  */
  readonly deadline: number;
}

interface Query extends Call {
  readonly prepared: readonly Prepared[];
  readonly signal: AbortSignal;
}

const MS_PER_SECOND = 1000;
/**
 * The time a query has beyond the build wait, for an index that exists but
 * whose content selection the sidecar builds on demand: less than the 10 s
 * the policy keeps between the wait and the call's own timeout (ACT-112).
 */
const QUERY_GRACE_MS = 8000;

function repoEntries(prepared: readonly Prepared[]) {
  return prepared.map((entry) => ({
    repo: entry.label,
    repository: entry.repository,
    ref: entry.ref,
    commit: entry.commit,
    indexed_at: entry.indexedAt,
    stale: entry.stale,
  }));
}

function resultEntries(results: readonly SidecarResult[]) {
  return results.map((result) => ({
    repo: result.label,
    file_path: result.file_path,
    start_line: result.start_line,
    end_line: result.end_line,
    score: result.score,
    language: result.language ?? null,
    ...(result.content !== undefined && { content: result.content }),
  }));
}

/**
ACT-52: whole results dropped from the end until the answer fits `maxBytes`.
*/
function fitted(
  query: string,
  results: readonly SidecarResult[],
  prepared: readonly Prepared[],
  maxBytes: number,
): ConnectorOutput {
  let kept = resultEntries(results);
  const repos = repoEntries(prepared);
  const size = (entries: typeof kept): number =>
    Buffer.byteLength(JSON.stringify({ query, results: entries, repos }), 'utf8');
  while (kept.length > 0 && size(kept) > maxBytes) {
    kept = kept.slice(0, -1);
  }
  return {
    result: { query, results: kept, repos, truncated: kept.length < results.length },
    captured: {},
    bytes: size(kept),
  };
}

async function answer(
  dependencies: RunDependencies,
  query: Query,
): Promise<SidecarOutcome<ConnectorOutput>> {
  const { operation, prepared, content, signal, contexts } = query;
  const maxBytes = Math.min(...contexts.map((context) => context.outputLimit.maxBytes));
  const indexes = prepared.map((entry) => ({ key: entry.key, label: entry.label }));
  const policies = contexts.map((context) => documentsOf(context).policy);
  if (isSearch(operation)) {
    const { query: text, max_snippet_lines, paths, languages } = operation;
    const top_k = topKFor(policies, operation.top_k);
    const found = await dependencies.sidecar.search(
      { indexes, content, query: text, top_k, max_snippet_lines, paths, languages },
      signal,
    );
    return found.ok ? ok(fitted(text, found.value, prepared, maxBytes)) : found;
  }
  if (isRelated(contexts[0].tool, operation)) {
    const { file_path, line, max_snippet_lines } = operation;
    const top_k = topKFor(policies, operation.top_k);
    const found = await dependencies.sidecar.related(
      { indexes, content, file_path, line, top_k, max_snippet_lines },
      signal,
    );
    const label = `Chunks related to ${file_path}:${String(line)}`;
    return found.ok ? ok(fitted(label, found.value, prepared, maxBytes)) : found;
  }
  const [only] = prepared as readonly [Prepared];
  const maxLines = documentsOf(contexts[0]).policy.max_read_lines;
  return readFile(dependencies.sidecar, { prepared: only, operation, maxLines, signal });
}

/**
 * Every repository prepared at once, so each build starts at the start of the
 * wait; the first that cannot be prepared ends the call, and with several it
 * is named (ACT-110).
 */
async function prepareAll(
  dependencies: RunDependencies,
  call: Call,
): Promise<Result<readonly Prepared[], ActionError>> {
  const isSeveral = call.contexts.length > 1;
  const settled = await Promise.all(
    call.contexts.map(async (context) => {
      const { ref } = call.operation;
      const request = { context, ref, content: call.content, deadline: call.deadline };
      const one = await dependencies.indexes.prepare(request);
      return !isSeveral || one.ok ? one : fail(withRepo(one.error, context.support.target.name));
    }),
  );
  const prepared: Prepared[] = [];
  for (const one of settled) {
    if (!one.ok) {
      return one;
    }
    prepared.push(one.value);
  }
  return ok(prepared);
}

function withRepo(error: ActionError, repo: string): ActionError {
  return new ActionError(error.code, { ...error.detail, repo });
}

type Attempt =
  | { readonly kind: 'done'; readonly result: Result<ConnectorOutput, ActionError> }
  | { readonly kind: 'evicted' };

function done(result: Result<ConnectorOutput, ActionError>): Attempt {
  return { kind: 'done', result };
}

/**
 * What a failed query means: `snapshot_missing` asks for another preparation;
 * a query the grace cut short is an index still building; anything else is
 * the refusal's own error.
 */
function afterFailure(
  dependencies: RunDependencies,
  query: Query,
  error: ActionError | SidecarRefusal,
): Attempt {
  // A refusal that names a snapshot is about that repository alone.
  const named =
    error instanceof SidecarRefusal
      ? query.prepared.find((entry) => entry.key === error.key)
      : undefined;
  const repos = named?.label ?? query.prepared.map((entry) => entry.label).join(',');
  if (error instanceof SidecarRefusal && error.code === 'snapshot_missing') {
    const missing = named === undefined ? query.prepared : [named];
    for (const entry of missing) {
      dependencies.indexes.forget(entry.targetId, entry.key);
    }
    return { kind: 'evicted' };
  }
  const isCutShort = error instanceof ActionError && error.code === 'timeout';
  return done(
    fail(
      isCutShort
        ? new ActionError('index_not_ready', { state: 'building', repo: repos })
        : refusalError(error, repos),
    ),
  );
}

/**
One preparation and one query; a snapshot the sidecar has since evicted asks for another.
*/
async function attempt(dependencies: RunDependencies, call: Call): Promise<Attempt> {
  const ready = await prepareAll(dependencies, call);
  if (!ready.ok) {
    return done(ready);
  }
  const { clock } = dependencies;
  const remaining = Math.max(call.deadline - clock.now(), 0) + QUERY_GRACE_MS;
  return withDeadline(
    clock,
    remaining,
    async (signal) => {
      const query = { ...call, prepared: ready.value, signal };
      const answered = await answer(dependencies, query);
      return answered.ok ? done(answered) : afterFailure(dependencies, query, answered.error);
    },
    call.contexts[0].signal,
  );
}

export async function runCode(
  dependencies: RunDependencies,
  contexts: readonly [Context, ...Context[]],
  operation: CodeOperation,
): Promise<Result<ConnectorOutput, ActionError>> {
  const policies = contexts.map((context) => documentsOf(context).policy);
  const content = sharedContent(policies, contentOf(operation));
  if (content.length === 0) {
    return fail(new ActionError('policy_denied', { reason: 'content' }));
  }
  if (isRead(contexts[0].tool, operation) && contexts.length > 1) {
    return fail(new ActionError('invalid_arguments', { problem: 'code_read takes one repo' }));
  }
  const wait = Math.min(...policies.map((policy) => policy.build_wait_s));
  const call: Call = {
    contexts,
    operation,
    content,
    deadline: dependencies.clock.now() + wait * MS_PER_SECOND,
  };
  const firstTry = await attempt(dependencies, call);
  if (firstTry.kind === 'done') {
    return firstTry.result;
  }
  const secondTry = await attempt(dependencies, call);
  return secondTry.kind === 'done' ? secondTry.result : fail(new ActionError('index_unavailable'));
}
