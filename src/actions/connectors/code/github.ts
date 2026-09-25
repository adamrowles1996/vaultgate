/**
 * GitHub through the pinned transport (ACT-103, ACT-104): resolving a ref to
 * a commit, the repository's own description, the repositories a token can
 * read (ACT-119) and the archive of one commit behind exactly one redirect.
 * The token is sent to `api.github.com` only, never to the archive host, and
 * the redirect URL, which carries a short-lived token of its own, is handed
 * to `capture` so it is scrubbed like an injected value.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { encodePath, isCommitSha, type ReferenceSpec as ReferenceSpec } from './references.ts';
import { GITHUB_API_HOST, GITHUB_ARCHIVE_HOST } from './schemas.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';

/**
What one GitHub exchange needs: the transport, both pinned addresses and the token, if any.
*/
export interface GitHubAccess {
  readonly fetch: PinnedFetch;
  readonly apiAddress: string;
  readonly archiveAddress: string;
  readonly token: string | undefined;
  readonly signal: AbortSignal;
  readonly userAgent: string;
  readonly capture: (field: string, value: Buffer) => void;
}

export interface ResolvedReference {
  readonly commit: string;
  /**
  The name the ref resolved from: the default branch's, the ref's own, the SHA or `pr:<n>`.
  */
  readonly ref: string;
}

export interface RepoInfo {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: string;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REPOSITORY_PAGES = 10;
const PER_PAGE = 100;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const COMMIT_SHA = /^[\da-f]{40}$/u;

const repoSchema = z.looseObject({
  full_name: z.string(),
  default_branch: z.string(),
  visibility: z.string().optional(),
  private: z.boolean().optional(),
});

const pullSchema = z.looseObject({ head: z.looseObject({ sha: z.string().regex(COMMIT_SHA) }) });

function apiHeaders(access: GitHubAccess, accept: string): Record<string, string> {
  return {
    accept,
    'user-agent': access.userAgent,
    'x-github-api-version': '2022-11-28',
    ...(access.token !== undefined && { authorization: `Bearer ${access.token}` }),
  };
}

/**
A GitHub status as the error an agent may see; the body is never quoted.
*/
function statusError(status: number): ActionError {
  return status === 401
    ? new ActionError('authentication_failed')
    : new ActionError('upstream_error', { status, message: `GitHub answered ${String(status)}` });
}

async function get(
  access: GitHubAccess,
  path: string,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  return access.fetch({
    url: `https://${GITHUB_API_HOST}${path}`,
    address: access.apiAddress,
    method: 'GET',
    headers: apiHeaders(access, accept),
    signal: access.signal,
  });
}

async function readText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_JSON_BYTES ? '' : text;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await readText(response)) as unknown;
  } catch {
    return undefined;
  }
}

function transportError(error: unknown, signal: AbortSignal): ActionError {
  if (signal.aborted) {
    return new ActionError('timeout');
  }
  const code = (error as { code?: unknown }).code;
  const isTls = typeof code === 'string' && code.startsWith('ERR_TLS');
  return new ActionError(isTls ? 'tls_error' : 'connection_failed');
}

/**
One GET whose body a schema validates, as a `Result`.
*/
async function getJson<T>(
  access: GitHubAccess,
  path: string,
  schema: z.ZodType<T>,
  missing: ActionError,
): Promise<Result<T, ActionError>> {
  let response: Response;
  try {
    response = await get(access, path);
  } catch (error) {
    return fail(transportError(error, access.signal));
  }
  if (response.status === 404 || response.status === 422) {
    return fail(missing);
  }
  if (response.status !== 200) {
    return fail(statusError(response.status));
  }
  const parsed = schema.safeParse(await readJson(response));
  return parsed.success
    ? ok(parsed.data)
    : fail(new ActionError('upstream_error', { message: 'GitHub answered out of shape' }));
}

const REPOSITORY_MISSING = new ActionError('upstream_error', {
  status: 404,
  message: 'the repository was not found, or the token cannot read it',
});

export async function repoInfo(
  access: GitHubAccess,
  repo: string,
): Promise<Result<RepoInfo, ActionError>> {
  const found = await getJson(access, `/repos/${encodePath(repo)}`, repoSchema, REPOSITORY_MISSING);
  if (!found.ok) {
    return found;
  }
  const visibility =
    found.value.visibility ?? (found.value.private === true ? 'private' : 'public');
  return ok({
    fullName: found.value.full_name,
    defaultBranch: found.value.default_branch,
    visibility,
  });
}

async function commitOf(
  access: GitHubAccess,
  repo: string,
  name: string,
): Promise<Result<string, ActionError>> {
  let response: Response;
  try {
    response = await get(
      access,
      `/repos/${encodePath(repo)}/commits/${encodePath(name)}`,
      'application/vnd.github.sha',
    );
  } catch (error) {
    return fail(transportError(error, access.signal));
  }
  if (response.status === 404 || response.status === 422) {
    return fail(new ActionError('ref_not_found'));
  }
  if (response.status !== 200) {
    return fail(statusError(response.status));
  }
  const text = await readText(response);
  const sha = text.trim();
  return isCommitSha(sha)
    ? ok(sha)
    : fail(new ActionError('upstream_error', { message: 'GitHub answered out of shape' }));
}

/**
ACT-104: the commit a ref names, by the step its kind needs.
*/
export async function resolveReference(
  access: GitHubAccess,
  repo: string,
  spec: ReferenceSpec,
): Promise<Result<ResolvedReference, ActionError>> {
  switch (spec.kind) {
    case 'commit': {
      return ok({ commit: spec.sha, ref: spec.sha });
    }
    case 'name': {
      const commit = await commitOf(access, repo, spec.name);
      return commit.ok ? ok({ commit: commit.value, ref: spec.name }) : commit;
    }
    case 'pull': {
      const pull = await getJson(
        access,
        `/repos/${encodePath(repo)}/pulls/${String(spec.number)}`,
        pullSchema,
        new ActionError('ref_not_found'),
      );
      return pull.ok ? ok({ commit: pull.value.head.sha, ref: `pr:${String(spec.number)}` }) : pull;
    }
    case 'default': {
      const info = await repoInfo(access, repo);
      if (!info.ok) {
        return info;
      }
      const commit = await commitOf(access, repo, info.value.defaultBranch);
      return commit.ok ? ok({ commit: commit.value, ref: info.value.defaultBranch }) : commit;
    }
  }
}

const repoListSchema = z.array(
  z.looseObject({ full_name: z.string(), private: z.boolean().optional() }),
);

export interface ListedRepo {
  readonly fullName: string;
  readonly isPrivate: boolean;
}

/**
ACT-119: every repository the token can read, 100 a page and at most 10 pages.
*/
export async function listRepos(
  access: GitHubAccess,
): Promise<Result<readonly ListedRepo[], ActionError>> {
  const found: ListedRepo[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
    const batch = await getJson(
      access,
      `/user/repos?per_page=${String(PER_PAGE)}&page=${String(page)}&sort=full_name`,
      repoListSchema,
      new ActionError('upstream_error', { status: 404, message: 'GitHub has no such listing' }),
    );
    if (!batch.ok) {
      return batch;
    }
    found.push(
      ...batch.value.map((entry) => ({
        fullName: entry.full_name,
        isPrivate: entry.private === true,
      })),
    );
    if (batch.value.length < PER_PAGE) {
      break;
    }
  }
  return ok(found);
}

/**
ACT-104: the one redirect allowed, to the archive host under the same repository.
*/
export function archiveRedirectProblem(location: string, repo: string): string | undefined {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return 'the redirect is not a URL';
  }
  const isArchiveHost =
    url.protocol === 'https:' &&
    url.hostname === GITHUB_ARCHIVE_HOST &&
    (url.port === '' || url.port === '443') &&
    url.username === '' &&
    url.password === '';
  if (!isArchiveHost) {
    return 'the redirect leaves the archive host';
  }
  return url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/`)
    ? undefined
    : 'the redirect leaves the repository';
}

/**
ACT-104: the archive request's answer, after the one redirect it may take.
*/
async function followArchive(
  access: GitHubAccess,
  repo: string,
  response: Response,
): Promise<Result<Response, ActionError>> {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return ok(response);
  }
  await response.body?.cancel();
  const location = response.headers.get('location') ?? '';
  const problem = archiveRedirectProblem(location, repo);
  if (problem !== undefined) {
    return fail(new ActionError('upstream_error', { message: problem }));
  }
  access.capture('archive_url', Buffer.from(location, 'utf8'));
  return ok(
    await access.fetch({
      url: location,
      address: access.archiveAddress,
      method: 'GET',
      headers: { 'user-agent': access.userAgent },
      signal: access.signal,
    }),
  );
}

function archiveError(status: number): ActionError {
  if (status === 404) {
    return new ActionError('ref_not_found');
  }
  return REDIRECT_STATUSES.has(status)
    ? new ActionError('upstream_error', { message: 'a second redirect was refused' })
    : statusError(status);
}

/**
 * ACT-104, ACT-105: the archive of `commit`, as the stream the forge sends:
 * `GET /repos/{r}/tarball/{sha}` with the token, then at most one redirect to
 * the archive host, which is requested without `Authorization`.
 */
export async function openArchive(
  access: GitHubAccess,
  repo: string,
  commit: string,
): Promise<Result<ReadableStream<Uint8Array>, ActionError>> {
  let followed: Result<Response, ActionError>;
  try {
    const first = await get(access, `/repos/${encodePath(repo)}/tarball/${commit}`);
    followed = await followArchive(access, repo, first);
  } catch (error) {
    return fail(transportError(error, access.signal));
  }
  if (!followed.ok) {
    return followed;
  }
  const response = followed.value;
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    return fail(archiveError(response.status));
  }
  return ok(response.body as ReadableStream<Uint8Array>);
}
