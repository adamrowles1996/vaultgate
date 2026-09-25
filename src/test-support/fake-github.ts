/**
 * GitHub as the `code` connector sees it (ACT-103, ACT-104, ACT-119), behind
 * the `PinnedFetch` seam: repository metadata, ref resolution with the SHA
 * media type (branches, tags and `refs/pull/<n>/head`), the tarball redirect
 * to the archive host and the archive itself, and `/user/repos`. Every
 * request is recorded with its URL, pinned address and headers, so a test
 * can assert which host saw `Authorization`. A private repository answers
 * 404 to a request without the token, as GitHub does. `answer` overrides any
 * request (a status, a hang until abort, a transport error), and `echo`
 * puts the `Authorization` header wherever GitHub sends text back.
 */
import type { PinnedFetch, PinnedRequest } from '../net/pinned-https.ts';

export const FAKE_TOKEN = 'github_pat_CANARY_0123456789abcdef';
export const FAKE_ARCHIVE_TOKEN = 'CANARY-archive-token-9f8e7d';

export interface FakeRepo {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  /**
  Branch and tag names to commits.
  */
  readonly refs: Readonly<Record<string, string>>;
  readonly pulls?: Readonly<Record<number, string>>;
  /**
  The archive bytes of each commit.
  */
  readonly archives: Readonly<Record<string, Buffer>>;
}

export interface RecordedRequest {
  readonly url: string;
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
What `answer` may do with a request instead of the fake's own route.
*/
export type Scripted = Response | Error | 'hang' | undefined;

export interface FakeGitHubOptions {
  readonly repos: readonly FakeRepo[];
  /**
  The token that reads the private repositories; `FAKE_TOKEN` unless told otherwise.
  */
  readonly token?: string;
  /**
  Replaces the tarball redirect's Location (a redirect elsewhere, ACT-104).
  */
  readonly redirectTo?: (repo: FakeRepo, sha: string) => string;
  /**
  Answers a request itself, before any route; `undefined` lets the route answer.
  */
  readonly answer?: (url: URL, request: PinnedRequest) => Scripted;
  /**
  ACT-53: sends the request's `Authorization` back as the default branch's name and in the redirect.
  */
  readonly echo?: boolean;
}

export interface FakeGitHub {
  readonly fetch: PinnedFetch;
  readonly requests: RecordedRequest[];
}

const PULL_HEAD = /^refs\/pull\/(\d+)\/head$/u;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/json' } });
}

function notFound(): Response {
  return json({ message: 'Not Found' }, 404);
}

function tokenOf(options: FakeGitHubOptions): string {
  return options.token ?? FAKE_TOKEN;
}

function isAuthorised(options: FakeGitHubOptions, repo: FakeRepo, request: PinnedRequest): boolean {
  return !repo.isPrivate || request.headers['authorization'] === `Bearer ${tokenOf(options)}`;
}

function listing(options: FakeGitHubOptions, request: PinnedRequest, url: URL): Response {
  if (request.headers['authorization'] !== `Bearer ${tokenOf(options)}`) {
    return json({ message: 'Requires authentication' }, 401);
  }
  const perPage = Number(url.searchParams.get('per_page') ?? '30');
  const page = Number(url.searchParams.get('page') ?? '1');
  const all = options.repos.map((repo) => ({ full_name: repo.fullName, private: repo.isPrivate }));
  return json(all.slice((page - 1) * perPage, page * perPage));
}

/**
The commit a name resolves to; an echoed default branch resolves as the default branch does.
*/
function shaOf(options: FakeGitHubOptions, repo: FakeRepo, name: string, request: PinnedRequest) {
  const pull = PULL_HEAD.exec(name);
  if (pull !== null) {
    return repo.pulls?.[Number(pull[1])];
  }
  const isEcho = options.echo === true && name === request.headers['authorization'];
  return repo.refs[isEcho ? repo.defaultBranch : name];
}

function commitOf(
  options: FakeGitHubOptions,
  repo: FakeRepo,
  name: string,
  request: PinnedRequest,
): Response {
  if (request.headers['accept'] !== 'application/vnd.github.sha') {
    return json({ sha: 'not the media type the connector asks for' });
  }
  const sha = shaOf(options, repo, name, request);
  return sha === undefined
    ? json({ message: 'No commit found' }, 422)
    : new Response(sha, { status: 200 });
}

function redirect(options: FakeGitHubOptions, repo: FakeRepo, sha: string, request: PinnedRequest) {
  const token =
    options.echo === true ? (request.headers['authorization'] ?? '') : FAKE_ARCHIVE_TOKEN;
  const location =
    options.redirectTo?.(repo, sha) ??
    `https://codeload.github.com/${repo.fullName}/legacy.tar.gz/${sha}?token=${encodeURIComponent(token)}`;
  return new Response(null, { status: 302, headers: { location } });
}

function repoRoute(
  options: FakeGitHubOptions,
  repo: FakeRepo,
  rest: readonly string[],
  request: PinnedRequest,
): Response {
  const [kind, ...tail] = rest;
  const argument = tail.map((segment) => decodeURIComponent(segment)).join('/');
  switch (kind) {
    case undefined: {
      const branch = options.echo === true ? (request.headers['authorization'] ?? '') : undefined;
      return json({
        full_name: repo.fullName,
        default_branch: branch ?? repo.defaultBranch,
        visibility: repo.isPrivate ? 'private' : 'public',
        private: repo.isPrivate,
      });
    }
    case 'commits': {
      return commitOf(options, repo, argument, request);
    }
    case 'tarball': {
      return redirect(options, repo, argument, request);
    }
    default: {
      return notFound();
    }
  }
}

function api(options: FakeGitHubOptions, request: PinnedRequest, url: URL): Response {
  if (url.pathname === '/user/repos') {
    return listing(options, request, url);
  }
  const [, first, owner, name, ...rest] = url.pathname.split('/');
  const repo = options.repos.find(
    (candidate) =>
      candidate.fullName.toLowerCase() === `${owner ?? ''}/${name ?? ''}`.toLowerCase(),
  );
  return first !== 'repos' || repo === undefined || !isAuthorised(options, repo, request)
    ? notFound()
    : repoRoute(options, repo, rest, request);
}

function archive(options: FakeGitHubOptions, url: URL): Response {
  const [, owner, name, , sha] = url.pathname.split('/', 5);
  const repo = options.repos.find(
    (candidate) =>
      candidate.fullName.toLowerCase() === `${owner ?? ''}/${name ?? ''}`.toLowerCase(),
  );
  const bytes = repo?.archives[sha ?? ''];
  return bytes === undefined ? notFound() : new Response(bytes, { status: 200 });
}

/**
A request that never answers, as the real transport behaves: the abort fails it.
*/
function untilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    });
  });
}

function route(options: FakeGitHubOptions, request: PinnedRequest, url: URL): Promise<Response> {
  if (url.hostname === 'api.github.com') {
    return Promise.resolve(api(options, request, url));
  }
  return url.hostname === 'codeload.github.com'
    ? Promise.resolve(archive(options, url))
    : Promise.reject(new Error(`the fake GitHub has no host ${url.hostname}`));
}

export function createFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const requests: RecordedRequest[] = [];
  const fetch: PinnedFetch = (request) => {
    requests.push({ url: request.url, address: request.address, headers: { ...request.headers } });
    const url = new URL(request.url);
    const scripted = options.answer?.(url, request);
    if (scripted === 'hang') {
      return untilAborted(request.signal);
    }
    if (scripted instanceof Error) {
      return Promise.reject(scripted);
    }
    return scripted === undefined ? route(options, request, url) : Promise.resolve(scripted);
  };
  return { fetch, requests };
}
