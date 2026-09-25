/**
 * GitHub's API through the pinned transport (ACT-103): the headers every
 * request carries, the token sent as `Authorization: Bearer` to
 * `api.github.com` only and not at all without one, a body read up to a cap
 * and never further, and the error a status or a transport failure becomes.
 * `./github.ts` resolves refs over it and `./archive.ts` downloads.
 */
import { isTlsErrorCode } from '../../../net/tls-error.ts';
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { GITHUB_API_HOST } from './schemas.ts';

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
  /**
  ACT-51: a value GitHub hands over mid-call (the archive redirect's token) joins the scrub table.
  */
  readonly capture: (field: string, value: Buffer) => void;
  /**
  ACT-51: text from GitHub that vaultgate keeps beyond the call (a branch name), scrubbed first.
  */
  readonly scrub: (text: string) => string;
}

export interface Answered {
  readonly status: number;
  /**
  The body of a `200`, up to the cap; `undefined` for any other status or a body past the cap.
  */
  readonly text: string | undefined;
}

const JSON_MEDIA_TYPE = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function apiHeaders(access: GitHubAccess, accept: string): Record<string, string> {
  return {
    accept,
    'user-agent': access.userAgent,
    'x-github-api-version': API_VERSION,
    ...(access.token !== undefined && { authorization: `Bearer ${access.token}` }),
  };
}

/**
A GitHub status as the error an agent may see; the body is never quoted.
*/
export function statusError(status: number): ActionError {
  return status === 401
    ? new ActionError('authentication_failed')
    : new ActionError('upstream_error', { status, message: `GitHub answered ${String(status)}` });
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  }
  return 'unknown';
}

/**
 * ACT-59: an abort is the timeout; ACT-57: a certificate or TLS failure is
 * `tls_error`; anything else is `connection_failed`, with the error code
 * and never an address (ACT-74).
 */
export function transportError(error: unknown, signal: AbortSignal): ActionError {
  if (signal.aborted) {
    return new ActionError('timeout');
  }
  const code = errorCode(error);
  return new ActionError(isTlsErrorCode(code) ? 'tls_error' : 'connection_failed', {
    reason: code,
  });
}

export async function apiGet(
  access: GitHubAccess,
  path: string,
  accept = JSON_MEDIA_TYPE,
): Promise<Response> {
  return access.fetch({
    url: `https://${GITHUB_API_HOST}${path}`,
    address: access.apiAddress,
    method: 'GET',
    headers: apiHeaders(access, accept),
    signal: access.signal,
  });
}

/**
The body as text while it stays within `MAX_BODY_BYTES`; past that nothing more is read.
*/
async function readCapped(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    received += next.value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
One API `GET`: the status and, for a `200`, the body; a transport failure is its error.
*/
export async function apiText(
  access: GitHubAccess,
  path: string,
  accept = JSON_MEDIA_TYPE,
): Promise<Result<Answered, ActionError>> {
  try {
    const response = await apiGet(access, path, accept);
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return ok({ status: response.status, text: undefined });
    }
    return ok({ status: 200, text: await readCapped(response.body) });
  } catch (error) {
    return fail(transportError(error, access.signal));
  }
}
