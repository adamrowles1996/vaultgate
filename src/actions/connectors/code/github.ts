/**
 * GitHub's answers about a repository (ACT-104, ACT-119, ACT-120): the commit
 * a ref names, the repository's own description and the repositories a
 * token can read. Every step is one API `GET` through the pinned transport
 * (`./github-http.ts`); the archive download is `./archive.ts`.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { apiText, statusError, type GitHubAccess } from './github-http.ts';
import { encodePath, isCommitSha, parseReference } from './references.ts';

export type { GitHubAccess } from './github-http.ts';

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

export interface ListedRepo {
  readonly fullName: string;
  readonly isPrivate: boolean;
}

const SHA_MEDIA_TYPE = 'application/vnd.github.sha';
const MAX_REPOSITORY_PAGES = 10;
const PER_PAGE = 100;

const repoSchema = z.looseObject({
  full_name: z.string(),
  default_branch: z.string().min(1),
  visibility: z.string().optional(),
  private: z.boolean().optional(),
});

const repoListSchema = z.array(
  z.looseObject({ full_name: z.string(), private: z.boolean().optional() }),
);

function outOfShape(): ActionError {
  return new ActionError('upstream_error', { message: 'GitHub answered out of shape' });
}

function jsonOf<T>(schema: z.ZodType<T>): (text: string) => T | undefined {
  return (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const checked = schema.safeParse(parsed);
    return checked.success ? checked.data : undefined;
  };
}

function shaOf(text: string): string | undefined {
  const sha = text.trim();
  return isCommitSha(sha) ? sha : undefined;
}

interface Step<T> {
  readonly path: string;
  readonly accept?: string;
  readonly parse: (text: string) => T | undefined;
  /**
  What a `404` or `422` means here.
  */
  readonly missing: ActionError;
}

/**
ACT-104: one step; `404`/`422` is the step's own error, any other status or an odd body `upstream_error`.
*/
async function step<T>(access: GitHubAccess, spec: Step<T>): Promise<Result<T, ActionError>> {
  const answered = await apiText(access, spec.path, spec.accept);
  if (!answered.ok) {
    return answered;
  }
  const { status, text } = answered.value;
  if (status === 404 || status === 422) {
    return fail(spec.missing);
  }
  if (status !== 200) {
    return fail(statusError(status));
  }
  const parsed = text === undefined ? undefined : spec.parse(text);
  return parsed === undefined ? fail(outOfShape()) : ok(parsed);
}

async function commitOf(
  access: GitHubAccess,
  repo: string,
  name: string,
): Promise<Result<string, ActionError>> {
  return step(access, {
    path: `/repos/${encodePath(repo)}/commits/${encodePath(name)}`,
    accept: SHA_MEDIA_TYPE,
    parse: shaOf,
    missing: new ActionError('ref_not_found'),
  });
}

async function defaultBranchOf(
  access: GitHubAccess,
  repo: string,
): Promise<Result<ResolvedReference, ActionError>> {
  const found = await step(access, {
    path: `/repos/${encodePath(repo)}`,
    parse: jsonOf(repoSchema),
    missing: new ActionError('ref_not_found'),
  });
  if (!found.ok) {
    return found;
  }
  const branch = found.value.default_branch;
  const commit = await commitOf(access, repo, branch);
  return commit.ok ? ok({ commit: commit.value, ref: access.scrub(branch) }) : commit;
}

/**
 * ACT-104: the commit a ref names, by the step its kind needs; `undefined`
 * is the default branch. A ref that follows no rule of ACT-104 never reaches
 * a GitHub path at all.
 */
export async function resolveReference(
  access: GitHubAccess,
  repo: string,
  text: string | undefined,
): Promise<Result<ResolvedReference, ActionError>> {
  const spec = parseReference(text);
  if (spec === undefined) {
    return fail(
      new ActionError('invalid_arguments', { problem: 'ref: follows no rule of ACT-104' }),
    );
  }
  switch (spec.kind) {
    case 'commit': {
      return ok({ commit: spec.sha, ref: spec.sha });
    }
    case 'default': {
      return defaultBranchOf(access, repo);
    }
    case 'name': {
      const commit = await commitOf(access, repo, spec.name);
      return commit.ok ? ok({ commit: commit.value, ref: spec.name }) : commit;
    }
    case 'pull': {
      // GitHub keeps `refs/pull/<n>/head` in the base repository, for a pull
      // request from a fork too, and reading it needs `Contents: read` only.
      const commit = await commitOf(access, repo, `refs/pull/${String(spec.number)}/head`);
      return commit.ok ? ok({ commit: commit.value, ref: `pr:${String(spec.number)}` }) : commit;
    }
  }
}

/**
ACT-120: the repository as the chosen token sees it.
*/
export async function repoInfo(
  access: GitHubAccess,
  repo: string,
): Promise<Result<RepoInfo, ActionError>> {
  const found = await step(access, {
    path: `/repos/${encodePath(repo)}`,
    parse: jsonOf(repoSchema),
    missing: new ActionError('upstream_error', {
      status: 404,
      message: 'the repository was not found, or the token cannot read it',
    }),
  });
  if (!found.ok) {
    return found;
  }
  const { full_name: fullName, default_branch: defaultBranch } = found.value;
  const visibility =
    found.value.visibility ?? (found.value.private === true ? 'private' : 'public');
  return ok({ fullName, defaultBranch, visibility });
}

/**
ACT-119: every repository the token can read, 100 a page and at most 10 pages.
*/
export async function listRepos(
  access: GitHubAccess,
): Promise<Result<readonly ListedRepo[], ActionError>> {
  const found: ListedRepo[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
    const batch = await step(access, {
      path: `/user/repos?per_page=${String(PER_PAGE)}&page=${String(page)}&sort=full_name`,
      parse: jsonOf(repoListSchema),
      missing: new ActionError('upstream_error', {
        status: 404,
        message: 'GitHub has no such listing',
      }),
    });
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
