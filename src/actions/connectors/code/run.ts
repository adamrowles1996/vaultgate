/**
 * One code call over one or more repositories (ACT-110 to ACT-112): each
 * repository's snapshot is prepared (resolved, looked up, built while the call
 * waits), then the sidecar answers the search, related query or read. A
 * snapshot the sidecar has since evicted is prepared once more. Results keep
 * `semble`'s fields; a search result that would pass the output cap loses
 * results from the end (ACT-52).
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { isRead, isRelated, isSearch, selectedContent } from './authorize.ts';
import { documentsOf } from './builds.ts';
import { SidecarRefusal } from './sidecar.ts';

import type { ConnectorOutput, RunContext } from '../connector.ts';
import type { Indexes, Prepared } from './indexes.ts';
import type { ContentType } from './schemas.ts';
import type { SidecarResult } from './sidecar-schemas.ts';
import type { SidecarClient, SidecarOutcome } from './sidecar.ts';
import type { CodeOperation, ReadOperation } from './tools.ts';

type Context = RunContext<unknown, unknown, unknown>;

export interface RunDependencies {
  readonly sidecar: SidecarClient;
  readonly indexes: Indexes;
  readonly now: () => number;
}

/**
One query once every repository is prepared.
*/
interface Query {
  readonly contexts: readonly Context[];
  readonly first: Context;
  readonly operation: CodeOperation;
  readonly content: readonly ContentType[];
  readonly prepared: readonly Prepared[];
  readonly signal: AbortSignal;
}

const MS_PER_SECOND = 1000;
/**
Time a query is allowed beyond the build wait, for an index that already exists.
*/
const QUERY_GRACE_MS = 15_000;

const REFUSALS: Readonly<Record<string, ActionError['code']>> = {
  chunk_not_found: 'chunk_not_found',
  path_not_found: 'path_not_found',
  not_text: 'not_text',
  invalid_path: 'invalid_arguments',
  invalid_range: 'invalid_arguments',
};

function refusalError(refusal: SidecarRefusal): ActionError {
  const code = REFUSALS[refusal.code];
  if (code === undefined) {
    return new ActionError('connector_fault', { reason: 'sidecar', message: refusal.code });
  }
  return new ActionError(
    code,
    code === 'invalid_arguments' ? { problem: refusal.code } : undefined,
  );
}

/**
ACT-110: the selection every repository's policy allows; none shared is `policy_denied`.
*/
function sharedContent(
  contexts: readonly Context[],
  operation: CodeOperation,
): readonly ContentType[] | undefined {
  const selection = 'content' in operation ? operation.content : undefined;
  const allowed = contexts.map(
    (context) => selectedContent(documentsOf(context).policy, selection) ?? [],
  );
  const [first = [], ...rest] = allowed;
  const shared = first.filter((type) => rest.every((types) => types.includes(type)));
  return shared.length > 0 ? shared : undefined;
}

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

async function read(
  dependencies: RunDependencies,
  query: Query,
  operation: ReadOperation,
): Promise<SidecarOutcome<ConnectorOutput>> {
  const [prepared] = query.prepared;
  if (prepared === undefined) {
    return fail(new ActionError('invalid_arguments', { problem: 'code_read takes one repo' }));
  }
  const found = await dependencies.sidecar.read(
    {
      key: prepared.key,
      file_path: operation.file_path,
      start_line: operation.start_line,
      end_line: operation.end_line,
      max_lines: documentsOf(query.first).policy.max_read_lines,
    },
    query.signal,
  );
  if (!found.ok) {
    return found;
  }
  const { text, ...rest } = found.value;
  return ok({
    result: { repo: prepared.label, commit: prepared.commit, ...rest },
    captured: { text: Buffer.from(text, 'utf8') },
  });
}

async function answer(
  dependencies: RunDependencies,
  query: Query,
): Promise<SidecarOutcome<ConnectorOutput>> {
  const { operation, prepared, content, signal } = query;
  const maxBytes = Math.min(...query.contexts.map((context) => context.outputLimit.maxBytes));
  const indexes = prepared.map((entry) => ({ key: entry.key, label: entry.label }));
  if (isSearch(operation)) {
    const { query: text, top_k, max_snippet_lines, paths, languages } = operation;
    const found = await dependencies.sidecar.search(
      { indexes, content, query: text, top_k, max_snippet_lines, paths, languages },
      signal,
    );
    return found.ok ? ok(fitted(text, found.value, prepared, maxBytes)) : found;
  }
  if (isRelated(query.first.tool, operation)) {
    const { file_path, line, top_k, max_snippet_lines } = operation;
    const found = await dependencies.sidecar.related(
      { indexes, content, file_path, line, top_k, max_snippet_lines },
      signal,
    );
    const label = `Chunks related to ${file_path}:${String(line)}`;
    return found.ok ? ok(fitted(label, found.value, prepared, maxBytes)) : found;
  }
  return read(dependencies, query, operation);
}

async function prepareAll(
  dependencies: RunDependencies,
  contexts: readonly Context[],
  operation: CodeOperation,
  content: readonly ContentType[],
): Promise<Result<{ readonly prepared: Prepared[]; readonly deadline: number }, ActionError>> {
  const wait = Math.min(...contexts.map((context) => documentsOf(context).policy.build_wait_s));
  const deadline = dependencies.now() + wait * MS_PER_SECOND;
  const prepared: Prepared[] = [];
  for (const context of contexts) {
    const one = await dependencies.indexes.prepare({
      context,
      ref: operation.ref,
      content,
      deadline,
    });
    if (!one.ok) {
      return one;
    }
    prepared.push(one.value);
  }
  return ok({ prepared, deadline });
}

type Attempt =
  | { readonly kind: 'done'; readonly result: Result<ConnectorOutput, ActionError> }
  | { readonly kind: 'evicted' };

/**
One preparation and one query; a snapshot the sidecar has since evicted asks for another.
*/
async function attempt(
  dependencies: RunDependencies,
  query: Omit<Query, 'prepared' | 'signal'>,
): Promise<Attempt> {
  const ready = await prepareAll(dependencies, query.contexts, query.operation, query.content);
  if (!ready.ok) {
    return { kind: 'done', result: ready };
  }
  const { prepared, deadline } = ready.value;
  const remaining = Math.max(deadline - dependencies.now(), 0) + QUERY_GRACE_MS;
  const signal = AbortSignal.any([query.first.signal, AbortSignal.timeout(remaining)]);
  let answered: SidecarOutcome<ConnectorOutput>;
  try {
    answered = await answer(dependencies, { ...query, prepared, signal });
  } catch {
    const repos = prepared.map((entry) => entry.label).join(',');
    const failure = query.first.signal.aborted
      ? new ActionError('timeout')
      : new ActionError('index_not_ready', { state: 'building', repo: repos });
    return { kind: 'done', result: fail(failure) };
  }
  if (answered.ok) {
    return { kind: 'done', result: answered };
  }
  const { error } = answered;
  if (!(error instanceof SidecarRefusal)) {
    return { kind: 'done', result: fail(error) };
  }
  if (error.code !== 'snapshot_missing') {
    return { kind: 'done', result: fail(refusalError(error)) };
  }
  for (const [index, entry] of prepared.entries()) {
    const context = query.contexts[index];
    if (context !== undefined) {
      dependencies.indexes.forget(context.support.target.id, entry.key);
    }
  }
  return { kind: 'evicted' };
}

export async function runCode(
  dependencies: RunDependencies,
  contexts: readonly Context[],
  operation: CodeOperation,
): Promise<Result<ConnectorOutput, ActionError>> {
  const [first] = contexts;
  const content = sharedContent(contexts, operation);
  if (first === undefined || content === undefined) {
    return fail(new ActionError('policy_denied', { reason: 'content' }));
  }
  if (isRead(first.tool, operation) && contexts.length > 1) {
    return fail(new ActionError('invalid_arguments', { problem: 'code_read takes one repo' }));
  }
  const query = { contexts, first, operation, content };
  const firstTry = await attempt(dependencies, query);
  if (firstTry.kind === 'done') {
    return firstTry.result;
  }
  const secondTry = await attempt(dependencies, query);
  return secondTry.kind === 'done' ? secondTry.result : fail(new ActionError('index_unavailable'));
}
