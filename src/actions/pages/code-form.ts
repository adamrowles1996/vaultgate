/**
 * The `code` connector's form (spec 14.8, ACT-119): the repository and the
 * ref, the vault field holding a read-only GitHub token or none for a public
 * repository, what may be searched and read, and the caps a build runs
 * under. The repositories the token can read are offered beside the
 * repository field (`repo-source.ts`); the common policy fields keep
 * the connector's own call timeout and leave out the write confirmation,
 * since nothing a code target does is a write.
 */
import { CONTENT_TYPES, DEFAULT_EXCLUDE } from '../connectors/code/schemas.ts';

import type { ConnectorForm, FieldDescriptor } from './descriptors.ts';

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = KIB * MIB;

/**
The one field a connection names its token in (ACT-103).
*/
export const TOKEN_FIELD = 'credential.token_field';

function cap(
  name: string,
  label: string,
  limits: { readonly min: number; readonly max: number; readonly fallback: number },
  help: string,
): FieldDescriptor {
  return { document: 'policy', name, label, kind: 'number', ...limits, help };
}

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'repository',
    label: 'Repository',
    kind: 'text',
    required: true,
    offered: 'repositories',
    help: 'owner/name, as GitHub shows it: type it, or choose one the token can read.',
  },
  {
    document: 'destination',
    name: 'ref',
    label: 'Branch, tag or commit',
    kind: 'text',
    help:
      'Empty: the repository’s default branch, looked up at each freshness check. Otherwise a ' +
      'branch or tag name, or a full 40-character commit SHA.',
  },
];

const credential: readonly FieldDescriptor[] = [
  {
    document: 'credential',
    name: 'token_field',
    label: 'Token field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'password', none: 'No token (public repository)' },
    help:
      'The vault field holding a fine-grained GitHub token with Contents: read and Metadata: ' +
      'read and nothing else: password, custom.<name> for a hidden custom field, or none for a ' +
      'public repository read without a token.',
  },
];

const reading: readonly FieldDescriptor[] = [
  {
    document: 'policy',
    name: 'content',
    label: 'Content agents may search',
    kind: 'set',
    options: CONTENT_TYPES,
    fallback: CONTENT_TYPES,
    help:
      'Default all three, as semble sorts files: source code, documentation and configuration. ' +
      'A call may narrow the selection, never widen it; none ticked means all three. This limits ' +
      'what is searched, not what is read: code_read still reads any file the include and ' +
      'exclude patterns keep, whatever its type.',
  },
  {
    document: 'policy',
    name: 'allow_read',
    label: 'Allow code_read: agents may read whole files',
    kind: 'boolean',
    fallback: true,
    help: 'Off: agents see the snippets a search returns and nothing more.',
  },
  {
    document: 'policy',
    name: 'allow_ref',
    label: 'Allow a call to name another branch, tag, commit or pull request',
    kind: 'boolean',
    fallback: true,
    help: 'Off: every call reads the configured ref, and a call that names another is refused.',
  },
  {
    document: 'policy',
    name: 'include',
    label: 'Include',
    kind: 'lines',
    fallback: [],
    help: 'gitignore patterns, one per line, at most 100. Empty indexes every file.',
  },
  {
    document: 'policy',
    name: 'exclude',
    label: 'Exclude',
    kind: 'lines',
    fallback: DEFAULT_EXCLUDE,
    help:
      'gitignore patterns, one per line, at most 100, applied after include: an excluded file ' +
      'never reaches the index. The defaults keep secret files out; replacing the list replaces ' +
      'the defaults too, so keep the ones you still want. Empty means the defaults.',
  },
  cap(
    'max_top_k',
    'Most results per search',
    { min: 1, max: 200, fallback: 50 },
    'Default 50, at most 200.',
  ),
  cap(
    'max_read_lines',
    'Most lines per code_read',
    { min: 1, max: 2000, fallback: 400 },
    'Default 400, at most 2 000.',
  ),
  cap(
    'build_wait_s',
    'Wait for a build (s)',
    { min: 0, max: 290, fallback: 90 },
    'How long a call waits for an index still being built. Default 90, at most 290, and at least 10 seconds less than the timeout.',
  ),
  cap(
    'refresh_interval_s',
    'Freshness check (s)',
    { min: 60, max: 86_400, fallback: 300 },
    'How long a resolution of the configured ref stands before a call looks again. Default 300, 60 to 86 400.',
  ),
];

const caps: readonly FieldDescriptor[] = [
  cap(
    'max_archive_bytes',
    'Largest archive (bytes)',
    { min: MIB, max: GIB, fallback: 256 * MIB },
    'Default 268 435 456 (256 MiB), at most 1 073 741 824 (1 GiB); a larger download fails the build.',
  ),
  cap(
    'max_files',
    'Most files',
    { min: 1, max: 200_000, fallback: 50_000 },
    'Default 50 000, at most 200 000.',
  ),
  cap(
    'max_total_bytes',
    'Largest snapshot, uncompressed (bytes)',
    { min: MIB, max: 4 * GIB, fallback: GIB },
    'Default 1 073 741 824 (1 GiB), at most 4 294 967 296 (4 GiB).',
  ),
  cap(
    'max_file_bytes',
    'Largest file (bytes)',
    { min: KIB, max: 16 * MIB, fallback: MIB },
    'Default 1 048 576 (1 MiB), at most 16 777 216 (16 MiB); a larger file is skipped and counted.',
  ),
  cap(
    'build_timeout_s',
    'Build timeout (s)',
    { min: 10, max: 3600, fallback: 600 },
    'Default 600, at most 3 600; a build that runs longer fails and changes nothing.',
  ),
];

/**
The common timeout, with the code connector's own default (ACT-112's wait needs the room).
*/
const TIMEOUT: FieldDescriptor = cap(
  'timeout_ms',
  'Timeout (ms)',
  { min: 1000, max: 300_000, fallback: 150_000 },
  'Default 150 000, at most 300 000: a call may wait for a build, so leave it room.',
);

export const codeForm: ConnectorForm = {
  kind: 'code',
  fields: [...destination, ...credential, ...reading, ...caps],
  common: { omit: ['confirm_writes'], replace: [TIMEOUT] },
  network: 'public',
  notes: {
    destination:
      'The GitHub repository agents search. Saving checks that GitHub resolves to public ' +
      'addresses, then builds the index in the background.',
    credential:
      'Which of the vault item’s fields holds the GitHub token, or none for a public ' +
      'repository. Field names only: values stay in the vault.',
    policy: 'What agents may search and read, and the caps every build runs under.',
  },
};
