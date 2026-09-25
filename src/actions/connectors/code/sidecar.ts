/**
 * The client of the code sidecar (ACT-113): one method per protocol
 * operation, every response validated by `./sidecar-schemas.ts`. An
 * unreachable sidecar is `index_unavailable`; an answer out of shape is a
 * `connector_fault`; the protocol's own error codes are handed back for the
 * snapshot layer to act on (`snapshot_missing` means "build it").
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import {
  type BuildSpec,
  buildingSchema,
  deletedSchema,
  errorSchema,
  healthSchema,
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
A protocol error the sidecar answered with: its code and its detail.
*/
export class SidecarRefusal extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(`the code sidecar refused the request: ${code}`);
    this.name = 'SidecarRefusal';
    this.code = code;
    this.detail = detail;
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
  readonly accept?: readonly number[];
}

interface Answer<T> {
  readonly status: number;
  readonly value: T;
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

/**
The response, or `undefined` when the sidecar could not be reached; the caller's own abort is thrown.
*/
async function send(http: LocalHttp, request: Exchange): Promise<LocalResponse | undefined> {
  const isJson = request.json !== undefined;
  const payload = isJson ? Buffer.from(JSON.stringify(request.json), 'utf8') : request.body;
  try {
    return await http({
      method: request.method,
      path: request.path,
      headers: isJson
        ? { 'content-type': 'application/json', ...request.headers }
        : { ...request.headers },
      ...(payload !== undefined && { body: payload }),
      signal: request.signal,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }
    return undefined;
  }
}

function interpret<T>(
  response: LocalResponse,
  request: Exchange,
  schema: z.ZodType<T>,
): SidecarOutcome<Answer<T>> {
  const body = parseJson(response.body);
  if (!(request.accept ?? [200]).includes(response.status)) {
    const refusal = errorSchema.safeParse(body);
    return fail(
      refusal.success
        ? new SidecarRefusal(refusal.data.error, refusal.data.detail)
        : fault(`unexpected status ${String(response.status)}`),
    );
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? ok({ status: response.status, value: parsed.data })
    : fail(fault(`${request.method} ${request.path} answered out of shape`));
}

async function exchange<T>(
  http: LocalHttp,
  request: Exchange,
  schema: z.ZodType<T>,
): Promise<SidecarOutcome<Answer<T>>> {
  const response = await send(http, request);
  return response === undefined
    ? fail(new ActionError('index_unavailable'))
    : interpret(response, request, schema);
}

async function value<T>(
  http: LocalHttp,
  request: Exchange,
  schema: z.ZodType<T>,
): Promise<SidecarOutcome<T>> {
  const answered = await exchange(http, request, schema);
  return answered.ok ? ok(answered.value.value) : answered;
}

function snapshotPath(key: string): string {
  return `/v1/snapshots/${encodeURIComponent(key)}`;
}

async function status(
  http: LocalHttp,
  key: string,
  signal: AbortSignal,
): Promise<SidecarOutcome<SnapshotState>> {
  const request: Exchange = { method: 'GET', path: snapshotPath(key), signal, accept: [200, 202] };
  const answered = await exchange(http, request, snapshotMetaSchema.or(buildingSchema));
  if (!answered.ok) {
    const isMissing =
      answered.error instanceof SidecarRefusal && answered.error.code === 'snapshot_missing';
    return isMissing ? ok({ state: 'missing' }) : answered;
  }
  if (answered.value.status === BUILDING_STATUS) {
    return ok({ state: 'building' });
  }
  const meta = snapshotMetaSchema.safeParse(answered.value.value);
  return meta.success
    ? ok({ state: 'ready', meta: meta.data })
    : fail(fault('a snapshot answer out of shape'));
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
