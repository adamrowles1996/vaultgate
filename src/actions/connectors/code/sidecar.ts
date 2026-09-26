/**
 * The client of the code sidecar (ACT-113): one method per protocol
 * operation, every response validated by `./sidecar-schemas.ts`, and never
 * a throw. An unreachable sidecar is `index_unavailable`, the caller's own
 * abort `timeout`, an answer out of shape a `connector_fault`; the protocol's
 * own error codes come back as a `SidecarRefusal` for the snapshot layer to
 * act on (`snapshot_missing` means "build it").
 */
import { LocalResponseTooLarge } from '../../../net/local-http.ts';
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import {
  type BuildSpec,
  buildingSchema,
  deletedSchema,
  errorSchema,
  healthSchema,
  refusalKeySchema,
  type IndexReference,
  readSchema,
  resultsSchema,
  type SidecarHealth,
  type SidecarRead,
  type SidecarResult,
  type SnapshotList,
  snapshotListSchema,
  type SnapshotMeta,
  snapshotMetaSchema,
} from './sidecar-schemas.ts';

import type { LocalHttp, LocalMethod, LocalResponse } from '../../../net/local-http.ts';
import type { z } from 'zod';

/**
 * A protocol error the sidecar answered with, by its code, and the snapshot
 * key it names in `detail.key` when it names one well formed: the caller maps
 * it back to the repository it asked about, and never passes it on.
 */
export class SidecarRefusal extends Error {
  readonly code: string;
  readonly key: string | undefined;

  constructor(code: string, key?: string) {
    super(`the code sidecar refused the request: ${code}`);
    this.name = 'SidecarRefusal';
    this.code = code;
    this.key = key;
  }
}

export type SidecarOutcome<T> = Result<T, ActionError | SidecarRefusal>;

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const BUILDING_STATUS = 202;

export interface SearchQuery {
  readonly indexes: readonly IndexReference[];
  readonly content: readonly string[];
  readonly query: string;
  readonly top_k: number;
  readonly max_snippet_lines: number | null;
  readonly paths?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
}

export interface RelatedQuery {
  readonly indexes: readonly IndexReference[];
  readonly content: readonly string[];
  readonly file_path: string;
  readonly line: number;
  readonly top_k: number;
  readonly max_snippet_lines: number | null;
}

export interface ReadQuery {
  readonly key: string;
  readonly file_path: string;
  readonly start_line?: number | undefined;
  readonly end_line?: number | undefined;
  readonly max_lines: number;
}

export type SnapshotState =
  | { readonly state: 'ready'; readonly meta: SnapshotMeta }
  | { readonly state: 'building' }
  | { readonly state: 'missing' };

export interface SidecarClient {
  health(signal: AbortSignal): Promise<SidecarOutcome<SidecarHealth>>;
  build(
    key: string,
    spec: BuildSpec,
    archive: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<SidecarOutcome<SnapshotMeta>>;
  status(key: string, signal: AbortSignal): Promise<SidecarOutcome<SnapshotState>>;
  list(signal: AbortSignal): Promise<SidecarOutcome<SnapshotList>>;
  deleteSnapshot(key: string, signal: AbortSignal): Promise<SidecarOutcome<number>>;
  deleteOwner(owner: string, signal: AbortSignal): Promise<SidecarOutcome<number>>;
  search(query: SearchQuery, signal: AbortSignal): Promise<SidecarOutcome<SidecarResult[]>>;
  related(query: RelatedQuery, signal: AbortSignal): Promise<SidecarOutcome<SidecarResult[]>>;
  read(query: ReadQuery, signal: AbortSignal): Promise<SidecarOutcome<SidecarRead>>;
}

interface Exchange {
  readonly method: LocalMethod;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: AsyncIterable<Uint8Array>;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function fault(problem: string): ActionError {
  return new ActionError('connector_fault', { reason: 'sidecar_protocol', message: problem });
}

/**
Base64url without padding, as the `X-Vaultgate-Build` header carries the build spec.
*/
export function encodeBuildSpec(spec: BuildSpec): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

async function send(
  http: LocalHttp,
  request: Exchange,
): Promise<Result<LocalResponse, ActionError>> {
  const isJson = request.json !== undefined;
  const payload = isJson ? Buffer.from(JSON.stringify(request.json), 'utf8') : request.body;
  try {
    return ok(
      await http({
        method: request.method,
        path: request.path,
        headers: isJson
          ? { 'content-type': 'application/json', ...request.headers }
          : { ...request.headers },
        ...(payload !== undefined && { body: payload }),
        signal: request.signal,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      }),
    );
  } catch (error) {
    if (request.signal.aborted) {
      return fail(new ActionError('timeout'));
    }
    return fail(
      error instanceof LocalResponseTooLarge
        ? fault('the answer is too large')
        : new ActionError('index_unavailable'),
    );
  }
}

/**
A `200` as `schema` has it; any other status is the protocol error it carries.
*/
function interpret<T>(
  response: LocalResponse,
  request: Exchange,
  schema: z.ZodType<T>,
): SidecarOutcome<T> {
  const body = parseJson(response.body);
  if (response.status !== 200) {
    const refusal = errorSchema.safeParse(body);
    const named = refusalKeySchema.safeParse(body);
    return fail(
      refusal.success
        ? new SidecarRefusal(refusal.data.error, named.success ? named.data.detail.key : undefined)
        : fault(`unexpected status ${String(response.status)}`),
    );
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? ok(parsed.data)
    : fail(
        fault(`${request.method} ${request.path.split('/', 3).join('/')} answered out of shape`),
      );
}

async function value<T>(
  http: LocalHttp,
  request: Exchange,
  schema: z.ZodType<T>,
): Promise<SidecarOutcome<T>> {
  const sent = await send(http, request);
  return sent.ok ? interpret(sent.value, request, schema) : sent;
}

function snapshotPath(key: string): string {
  return `/v1/snapshots/${encodeURIComponent(key)}`;
}

async function status(
  http: LocalHttp,
  key: string,
  signal: AbortSignal,
): Promise<SidecarOutcome<SnapshotState>> {
  const request: Exchange = { method: 'GET', path: snapshotPath(key), signal };
  const sent = await send(http, request);
  if (!sent.ok) {
    return sent;
  }
  if (sent.value.status === BUILDING_STATUS) {
    const building = interpret({ ...sent.value, status: 200 }, request, buildingSchema);
    return building.ok ? ok({ state: 'building' }) : building;
  }
  const meta = interpret(sent.value, request, snapshotMetaSchema);
  if (meta.ok) {
    return ok({ state: 'ready', meta: meta.value });
  }
  const isMissing = meta.error instanceof SidecarRefusal && meta.error.code === 'snapshot_missing';
  return isMissing ? ok({ state: 'missing' }) : meta;
}

async function deleted(
  http: LocalHttp,
  path: string,
  signal: AbortSignal,
): Promise<SidecarOutcome<number>> {
  const answer = await value(http, { method: 'DELETE', path, signal }, deletedSchema);
  return answer.ok ? ok(answer.value.deleted) : answer;
}

async function results(
  http: LocalHttp,
  path: string,
  json: unknown,
  signal: AbortSignal,
): Promise<SidecarOutcome<SidecarResult[]>> {
  const found = await value(http, { method: 'POST', path, signal, json }, resultsSchema);
  return found.ok ? ok(found.value.results) : found;
}

function buildRequest(
  key: string,
  spec: BuildSpec,
  archive: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Exchange {
  return {
    method: 'PUT',
    path: snapshotPath(key),
    signal,
    headers: { 'content-type': 'application/gzip', 'x-vaultgate-build': encodeBuildSpec(spec) },
    body: archive,
  };
}

export function createSidecarClient(http: LocalHttp): SidecarClient {
  return {
    health: (signal) => value(http, { method: 'GET', path: '/v1/health', signal }, healthSchema),
    build: (key, spec, archive, signal) =>
      value(http, buildRequest(key, spec, archive, signal), snapshotMetaSchema),
    status: (key, signal) => status(http, key, signal),
    list: (signal) =>
      value(http, { method: 'GET', path: '/v1/snapshots', signal }, snapshotListSchema),
    deleteSnapshot: (key, signal) => deleted(http, snapshotPath(key), signal),
    deleteOwner: (owner, signal) =>
      deleted(http, `/v1/owners/${encodeURIComponent(owner)}`, signal),
    search: (query, signal) => results(http, '/v1/search', query, signal),
    related: (query, signal) => results(http, '/v1/related', query, signal),
    read: (query, signal) =>
      value(http, { method: 'POST', path: '/v1/read', signal, json: query }, readSchema),
  };
}
