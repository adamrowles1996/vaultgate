/**
 * GitHub as the `code` connector sees it (ACT-103, ACT-104, ACT-119), behind
 * the `PinnedFetch` seam: repository metadata, ref resolution, pull request
 * heads, the tarball redirect to the archive host and the archive itself,
 * and `/user/repos`. Every request is recorded with its URL, pinned address
 * and headers, so a test can assert which host saw `Authorization`. A private
 * repository answers 404 to a request without the token, as GitHub does.
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

export interface FakeGitHubOptions {
  readonly repos: readonly FakeRepo[];
  /**
  Replaces the tarball redirect's Location (a redirect elsewhere, ACT-104).
  */
  readonly redirectTo?: (repo: FakeRepo, sha: string) => string;
  /**
  Answers the archive host with this status instead of the archive.
  */
  readonly archiveStatus?: number;
  /**
  Answers every API request with this status (401, 403, 500…).
  */
  readonly apiStatus?: number;
}

export interface FakeGitHub {
  readonly fetch: PinnedFetch;
  readonly requests: RecordedRequest[];
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(): Response {
  return json({ message: 'Not Found' }, 404);
}

function isAuthorised(repo: FakeRepo, request: PinnedRequest): boolean {
  return !repo.isPrivate || request.headers['authorization'] === `Bearer ${FAKE_TOKEN}`;
}

function listing(options: FakeGitHubOptions, request: PinnedRequest, url: URL): Response {
  if (request.headers['authorization'] !== `Bearer ${FAKE_TOKEN}`) {
    return json({ message: 'Requires authentication' }, 401);
  }
  const perPage = Number(url.searchParams.get('per_page') ?? '30');
  const page = Number(url.searchParams.get('page') ?? '1');
  const all = options.repos.map((repo) => ({ full_name: repo.fullName, private: repo.isPrivate }));
  return json(all.slice((page - 1) * perPage, page * perPage));
}

function commitOf(repo: FakeRepo, name: string): Response {
  const sha = repo.refs[decodeURIComponent(name)];
  return sha === undefined
    ? json({ message: 'No commit found' }, 422)
    : new Response(sha, { status: 200 });
}

function repoRoute(options: FakeGitHubOptions, repo: FakeRepo, rest: readonly string[]): Response {
  const [kind, ...tail] = rest;
  const argument = tail.join('/');
  switch (kind) {
    case undefined: {
      return json({
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        visibility: repo.isPrivate ? 'private' : 'public',
        private: repo.isPrivate,
      });
    }
    case 'commits': {
      return commitOf(repo, argument);
    }
    case 'pulls': {
      const sha = repo.pulls?.[Number(argument)];
      return sha === undefined ? notFound() : json({ head: { sha } });
    }
    case 'tarball': {
      const location =
        options.redirectTo?.(repo, argument) ??
        `https://codeload.github.com/${repo.fullName}/legacy.tar.gz/${argument}?token=${FAKE_ARCHIVE_TOKEN}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    default: {
      return notFound();
    }
  }
}

function api(options: FakeGitHubOptions, request: PinnedRequest, url: URL): Response {
  if (options.apiStatus !== undefined) {
    return json({ message: 'refused' }, options.apiStatus);
  }
  if (url.pathname === '/user/repos') {
    return listing(options, request, url);
  }
  const [, first, owner, name, ...rest] = url.pathname.split('/');
  const repo = options.repos.find(
    (candidate) =>
      candidate.fullName.toLowerCase() === `${owner ?? ''}/${name ?? ''}`.toLowerCase(),
  );
  return first !== 'repos' || repo === undefined || !isAuthorised(repo, request)
    ? notFound()
    : repoRoute(options, repo, rest);
}

function archive(options: FakeGitHubOptions, url: URL): Response {
  if (options.archiveStatus !== undefined) {
    return new Response(null, { status: options.archiveStatus });
  }
  const [, owner, name, , sha] = url.pathname.split('/', 5);
  const repo = options.repos.find(
    (candidate) => candidate.fullName === `${owner ?? ''}/${name ?? ''}`,
  );
  const bytes = repo?.archives[sha ?? ''];
  return bytes === undefined ? notFound() : new Response(bytes, { status: 200 });
}

export function createFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const requests: RecordedRequest[] = [];
  const fetch: PinnedFetch = (request) => {
    requests.push({ url: request.url, address: request.address, headers: { ...request.headers } });
    const url = new URL(request.url);
    if (url.hostname === 'api.github.com') {
      return Promise.resolve(api(options, request, url));
    }
    return url.hostname === 'codeload.github.com'
      ? Promise.resolve(archive(options, url))
      : Promise.reject(new Error(`the fake GitHub has no host ${url.hostname}`));
  };
  return { fetch, requests };
}
