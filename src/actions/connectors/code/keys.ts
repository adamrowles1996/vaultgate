/**
 * Snapshot keys (ACT-107, ACT-109). A snapshot is one target at one commit
 * under one extraction policy, so its key is the target id, a fingerprint of
 * everything that shapes the extraction, and the commit. A key whose
 * fingerprint is no longer the target's belongs to a policy that has since
 * changed, and reconciliation deletes it.
 */
import { createHash } from 'node:crypto';

import { normaliseContent } from './schemas.ts';

import type { CodeCredential, CodeDestination, CodePolicy } from './schemas.ts';

const FINGERPRINT_LENGTH = 16;
/**
The target id is the sidecar protocol's `owner`: `^[a-z0-9][a-z0-9-]{0,63}$`.
*/
const KEY = /^([a-z\d][a-z\d-]{0,63})\.([\da-f]{16})\.([\da-f]{40})$/u;

export interface CodeDocuments {
  readonly destination: CodeDestination;
  readonly credential: CodeCredential;
  readonly policy: CodePolicy;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/**
What the sidecar's extraction depends on (ACT-106): the repository, the token and the caps.
*/
export function extractionFingerprint(documents: CodeDocuments): string {
  const { destination, credential, policy } = documents;
  return digest({
    repository: destination.repository.toLowerCase(),
    token_field: credential.token_field,
    include: policy.include,
    exclude: policy.exclude,
    max_archive_bytes: policy.max_archive_bytes,
    max_files: policy.max_files,
    max_total_bytes: policy.max_total_bytes,
    max_file_bytes: policy.max_file_bytes,
  });
}

/**
 * ACT-108: a revision that changes this deletes every snapshot of the
 * target first: the extraction, the content the policy allows, the ref the
 * connection follows, or the one cap the extraction does not depend on.
 */
export function resetFingerprint(documents: CodeDocuments): string {
  return digest({
    extraction: extractionFingerprint(documents),
    content: normaliseContent(documents.policy.content),
    ref: documents.destination.ref ?? null,
    build_timeout_s: documents.policy.build_timeout_s,
  });
}

export function snapshotKey(targetId: string, fingerprint: string, commit: string): string {
  return `${targetId}.${fingerprint}.${commit}`;
}

export interface ParsedKey {
  readonly targetId: string;
  readonly fingerprint: string;
  readonly commit: string;
}

export function parseSnapshotKey(key: string): ParsedKey | undefined {
  const match = KEY.exec(key);
  if (match === null) {
    return undefined;
  }
  const [, targetId = '', fingerprint = '', commit = ''] = match;
  return { targetId, fingerprint, commit };
}
