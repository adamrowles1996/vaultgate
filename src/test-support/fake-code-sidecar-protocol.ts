/**
 * The code sidecar protocol's rules as the fake sidecar enforces them
 * (`sidecars/code/PROTOCOL.md`, version 1): the identifier grammars, the
 * exact field lists of every request body and of the build spec (unknown
 * fields are refused), the snapshot metadata it answers with, and its error
 * shape. A client that drifts from the protocol fails against the fake the
 * way it would fail against the real sidecar: `400 invalid_request`.
 */
import type { LocalRequest, LocalResponse } from '../net/local-http.ts';

export type Route =
  'health' | 'build' | 'status' | 'list' | 'delete' | 'search' | 'related' | 'read';

export const KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
export const OWNER = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export const COMMIT = /^[0-9a-f]{40}$/u;

const CONTENT = new Set(['code', 'docs', 'config']);

export const SEARCH_FIELDS = [
  'indexes',
  'content',
  'query',
  'top_k',
  'max_snippet_lines',
  'paths',
  'languages',
];
export const RELATED_FIELDS = [
  'indexes',
  'content',
  'file_path',
  'line',
  'top_k',
  'max_snippet_lines',
];
export const READ_FIELDS = ['key', 'file_path', 'start_line', 'end_line', 'max_lines'];
const SPEC_FIELDS = [
  'owner',
  'commit',
  'include',
  'exclude',
  'max_archive_bytes',
  'max_files',
  'max_total_bytes',
  'max_file_bytes',
  'build_timeout_s',
  'variants',
];

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

export interface FakeSnapshot {
  readonly key: string;
  readonly owner: string;
  readonly commit: string;
  readonly createdAt: number;
  readonly variants: string[];
}

export interface BuildSpecSeen {
  readonly owner: string;
  readonly commit: string;
  readonly variants: readonly (readonly string[])[];
  readonly [field: string]: unknown;
}

export function respond(status: number, body: unknown): LocalResponse {
  return { status, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

export function refusal(status: number, error: string): LocalResponse {
  return respond(status, { error, message: `the fake sidecar refused: ${error}` });
}

export function invalid(): LocalResponse {
  return refusal(400, 'invalid_request');
}

export function hasOnlyFields(body: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  return Object.keys(body).every((key) => allowed.includes(key));
}

/**
A content list as the protocol normalises it (`code`, `docs`, `config` order), or `undefined`.
*/
export function variantOf(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const types = content as unknown[];
  return types.some((type) => !(typeof type === 'string' && CONTENT.has(type)))
    ? undefined
    : ['code', 'docs', 'config'].filter((type) => types.includes(type)).join('+');
}

/**
The `X-Vaultgate-Build` header decoded and checked field by field, or `undefined`.
*/
export function parseSpec(header: string | undefined): BuildSpecSeen | undefined {
  if (header === undefined || header.includes('=')) {
    return undefined;
  }
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const keys = Object.keys(spec).toSorted(byName);
  const isExact = keys.join(',') === [...SPEC_FIELDS].toSorted(byName).join(',');
  const variants = spec['variants'];
  const isValid =
    isExact &&
    OWNER.test(String(spec['owner'])) &&
    COMMIT.test(String(spec['commit'])) &&
    Array.isArray(variants) &&
    variants.every((variant) => variantOf(variant) !== undefined);
  return isValid ? (spec as BuildSpecSeen) : undefined;
}

export function metaOf(snapshot: FakeSnapshot) {
  return {
    key: snapshot.key,
    owner: snapshot.owner,
    commit: snapshot.commit,
    created_at: snapshot.createdAt,
    last_used_at: snapshot.createdAt,
    files: 3,
    bytes: 300,
    skipped: { links: 1, special: 0, excluded: 2, large: 0 },
    storage_bytes: 4096,
    variants: Object.fromEntries(
      snapshot.variants.map((variant) => [
        variant,
        { files: 3, chunks: 7, built_at: snapshot.createdAt, duration_ms: 12 },
      ]),
    ),
  };
}

/**
Every byte of a streamed body, into `into`; a stream that fails fails the request, as a reset connection does.
*/
export async function drain(body: LocalRequest['body'], into: Buffer[]): Promise<Buffer> {
  if (body === undefined || Buffer.isBuffer(body)) {
    into.push(body ?? Buffer.alloc(0));
    return Buffer.concat(into);
  }
  for await (const chunk of body) {
    into.push(Buffer.from(chunk));
  }
  return Buffer.concat(into);
}

export function jsonBody(request: LocalRequest): Record<string, unknown> | undefined {
  if (!Buffer.isBuffer(request.body) || request.headers?.['content-type'] !== 'application/json') {
    return undefined;
  }
  try {
    return JSON.parse(request.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
A read as the protocol answers it: lines split, the range cut at `max_lines`, `not_text` for a NUL.
*/
export function readAnswer(body: Readonly<Record<string, unknown>>, text: string): LocalResponse {
  if (text.slice(0, 8192).includes('\0')) {
    return refusal(422, 'not_text');
  }
  const lines = text === '' ? [] : text.split('\n');
  const start = Number(body['start_line'] ?? 1);
  if (lines.length > 0 && start > lines.length) {
    return refusal(400, 'invalid_range');
  }
  const last = Math.min(Number(body['end_line'] ?? lines.length), lines.length);
  const end = Math.min(last, start + Number(body['max_lines']) - 1);
  return respond(200, {
    file_path: body['file_path'],
    start_line: start,
    end_line: end,
    total_lines: lines.length,
    text: lines.slice(start - 1, end).join('\n'),
    truncated: end < last,
  });
}

export function healthAnswer(protocol: number, snapshots: number, building: number): LocalResponse {
  return respond(200, {
    protocol,
    semble: '0.6.1',
    model: 'minishlab/potion-code-16M-v2',
    model_revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
    python: '3.12.7',
    limits: { max_snapshots: 64, max_storage_bytes: 0, max_memory_bytes: 0, build_concurrency: 1 },
    usage: { snapshots, storage_bytes: 0, loaded_variants: 0, loaded_bytes: 0, building },
  });
}

export function routeOf(request: LocalRequest): {
  readonly route: Route;
  readonly argument: string;
} {
  const [kind = '', argument = ''] = request.path.split('/').slice(2);
  const decoded = decodeURIComponent(argument);
  if (kind === 'snapshots') {
    const byMethod: Readonly<Record<string, Route>> = { PUT: 'build', DELETE: 'delete' };
    const route = byMethod[request.method] ?? (decoded === '' ? 'list' : 'status');
    return { route, argument: decoded };
  }
  return kind === 'owners'
    ? { route: 'delete', argument: `owner:${decoded}` }
    : { route: kind as Route, argument: decoded };
}

export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}
