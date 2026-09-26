/**
 * The archive of one commit (ACT-104, ACT-105): `GET
 * /repos/{repository}/tarball/{sha}` with the token, then at most one
 * redirect, to `https://codeload.github.com/` under the same repository,
 * which is requested without `Authorization`. The redirect URL carries a
 * short-lived token of its own, so it and each of its query values join the
 * call's scrub table (ACT-50) before anything else happens.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { apiGet, statusError, transportError, type GitHubAccess } from './github-http.ts';
import { encodePath } from './references.ts';
import { GITHUB_ARCHIVE_HOST } from './schemas.ts';

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
ACT-104: why a redirect is refused, or `undefined` for the one allowed.
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
    url.port === '' &&
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
ACT-50, ACT-51: the redirect and every query value it carries are scrubbed like injected values.
*/
function captureRedirect(access: GitHubAccess, location: string): void {
  access.capture('archive_url', Buffer.from(location, 'utf8'));
  const { searchParams } = new URL(location);
  for (const value of searchParams.values()) {
    if (value !== '') {
      access.capture('archive_token', Buffer.from(value, 'utf8'));
    }
  }
}

/**
The archive request's answer, after the one redirect it may take.
*/
async function follow(
  access: GitHubAccess,
  repo: string,
  first: Response,
): Promise<Result<Response, ActionError>> {
  if (!REDIRECT_STATUSES.has(first.status)) {
    return ok(first);
  }
  await first.body?.cancel();
  const location = first.headers.get('location') ?? '';
  const problem = archiveRedirectProblem(location, repo);
  if (problem !== undefined) {
    return fail(new ActionError('upstream_error', { message: problem }));
  }
  captureRedirect(access, location);
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

/**
ACT-104: a commit the API or codeload has no archive of (`404` or `422`) is `ref_not_found`.
*/
function archiveError(status: number): ActionError {
  if (status === 404 || status === 422) {
    return new ActionError('ref_not_found');
  }
  return REDIRECT_STATUSES.has(status)
    ? new ActionError('upstream_error', { message: 'a second redirect was refused' })
    : statusError(status);
}

/**
ACT-105: the archive of `commit` as the stream the forge sends it; nothing here reads it.
*/
export async function openArchive(
  access: GitHubAccess,
  repo: string,
  commit: string,
): Promise<Result<ReadableStream<Uint8Array>, ActionError>> {
  let followed: Result<Response, ActionError>;
  try {
    const first = await apiGet(access, `/repos/${encodePath(repo)}/tarball/${commit}`);
    followed = await follow(access, repo, first);
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
  return ok(response.body);
}
