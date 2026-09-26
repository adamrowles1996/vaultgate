/**
 * What a sidecar refusal means to the agent (ACT-111, ACT-112, §13.16). The
 * path, chunk and text codes pass through under their own names; a malformed
 * path or range is `invalid_arguments`; an index that failed to build is
 * `index_not_ready` with `state: failed` and the reason code, never a
 * message; anything else the protocol did not promise is a `connector_fault`.
 */
import { ActionError } from '../../errors.ts';

import { SidecarRefusal } from './sidecar.ts';

const PASSED_THROUGH: ReadonlySet<string> = new Set([
  'chunk_not_found',
  'path_not_found',
  'not_text',
]);

const INVALID: ReadonlySet<string> = new Set(['invalid_path', 'invalid_range']);

/**
The sidecar's own reasons a build failed: the archive or the index, not the way to them.
*/
const BUILD_FAILURES: ReadonlySet<string> = new Set([
  'archive_invalid',
  'archive_too_large',
  'build_failed',
  'build_timeout',
  'storage_full',
]);

/**
 * ACT-104, ACT-112: whether a build's end is remembered for the refresh
 * interval, so the archive is not fetched again (nor the credential lent,
 * nor another build event written) on every call: the build's own failures,
 * which a call answers as `index_not_ready`, and a commit GitHub has no
 * archive of, which it answers as `ref_not_found`. An unreachable sidecar, a
 * transport failure or a credential that could not be lent is none of these.
 */
export function isRemembered(reason: string): boolean {
  return BUILD_FAILURES.has(reason) || reason === 'ref_not_found';
}

function fromRefusal(code: string, repo: string): ActionError {
  if (PASSED_THROUGH.has(code)) {
    return new ActionError(code as 'chunk_not_found' | 'path_not_found' | 'not_text');
  }
  if (INVALID.has(code)) {
    return new ActionError('invalid_arguments', { problem: code });
  }
  return BUILD_FAILURES.has(code)
    ? new ActionError('index_not_ready', { state: 'failed', repo, reason: code })
    : new ActionError('connector_fault', { reason: 'sidecar', message: code });
}

/**
The error an agent receives for a sidecar failure; `repo` names the repositories the request read.
*/
export function refusalError(error: ActionError | SidecarRefusal, repo: string): ActionError {
  return error instanceof SidecarRefusal ? fromRefusal(error.code, repo) : error;
}
