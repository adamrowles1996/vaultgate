import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  LocalResponseTooLarge,
  type LocalHttp,
  type LocalRequest,
} from '../../../net/local-http.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { ActionError } from '../../errors.ts';

import { createSidecarClient, encodeBuildSpec, SidecarRefusal } from './sidecar.ts';

import type { BuildSpec } from './sidecar-schemas.ts';

const KEY = `id-1.0123456789abcdef.${'a'.repeat(40)}`;

const META = {
  key: KEY,
  owner: 'id-1',
  commit: 'a'.repeat(40),
  created_at: 1_790_000_000_000,
  last_used_at: 1_790_000_000_000,
  files: 3,
  bytes: 300,
  skipped: { links: 1, special: 0, excluded: 2, large: 0 },
  storage_bytes: 4096,
  variants: { code: { files: 3, chunks: 7, built_at: 1_790_000_000_000, duration_ms: 12 } },
};

const SPEC: BuildSpec = {
  owner: 'id-1',
  commit: 'a'.repeat(40),
  include: [],
  exclude: ['.env'],
  max_archive_bytes: 1024,
  max_files: 10,
  max_total_bytes: 2048,
  max_file_bytes: 512,
  build_timeout_s: 60,
  variants: [['code', 'docs']],
};

interface Scripted {
  readonly http: LocalHttp;
  readonly requests: LocalRequest[];
}

function answering(status: number, body: unknown): Scripted {
  const requests: LocalRequest[] = [];
  return {
    requests,
    http: (request) => {
      requests.push(request);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve({ status, body: Buffer.from(text, 'utf8') });
    },
  };
}

function failing(error: unknown): LocalHttp {
  return () => Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

const signal = new AbortController().signal;

function jsonOf(request: LocalRequest | undefined): unknown {
  return Buffer.isBuffer(request?.body) ? JSON.parse(request.body.toString('utf8')) : undefined;
}

function chunks(): AsyncIterable<Uint8Array> {
  return Readable.from([Buffer.from('gzip '), Buffer.from('bytes')]);
}

const UNREACHABLE = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });

function clientFailing(error: unknown) {
  return createSidecarClient(failing(error));
}

describe('the sidecar client requests (ACT-113)', () => {
  it('ACT-113 asks for health and validates the answer', async () => {
    const scripted = answering(200, {
      protocol: 1,
      semble: '0.6.1',
      model: 'm',
      model_revision: 'r',
      extra: 1,
    });
    const client = createSidecarClient(scripted.http);
    expect(unwrapOk(await client.health(signal)).protocol).toBe(1);
    expect(
      scripted.requests.map((request) => [request.method, request.path, request.maxResponseBytes]),
    ).toStrictEqual([['GET', '/v1/health', 16 * 1024 * 1024]]);
    const odd = createSidecarClient(answering(200, { protocol: '1' }).http);
    const error = unwrapFail(await odd.health(signal));
    expect(error instanceof ActionError && [error.code, error.detail]).toStrictEqual([
      'connector_fault',
      { reason: 'sidecar_protocol', message: 'GET /v1/health answered out of shape' },
    ]);
  });

  it('ACT-105 ACT-113 streams the archive to PUT /v1/snapshots/{key} with the spec in X-Vaultgate-Build, base64url without padding', async () => {
    const scripted = answering(200, META);
    const archive = chunks();
    expect(
      unwrapOk(await createSidecarClient(scripted.http).build(KEY, SPEC, archive, signal)),
    ).toStrictEqual(META);
    const [request] = scripted.requests;
    expect([request?.method, request?.path, request?.body]).toStrictEqual([
      'PUT',
      `/v1/snapshots/${KEY}`,
      archive,
    ]);
    expect(request?.headers).toStrictEqual({
      'content-type': 'application/gzip',
      'x-vaultgate-build': encodeBuildSpec(SPEC),
    });
    const header = encodeBuildSpec(SPEC);
    expect(header).not.toContain('=');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toStrictEqual(SPEC);
  });

  it('ACT-113 posts search, related and read as JSON with exactly the given fields', async () => {
    const scripted = answering(200, { results: [], variants: [] });
    const client = createSidecarClient(scripted.http);
    const indexes = [{ key: KEY, label: 'widgets' }];
    await client.search(
      {
        indexes,
        content: ['code'],
        query: 'q',
        top_k: 5,
        max_snippet_lines: null,
        paths: undefined,
        languages: ['python'],
      },
      signal,
    );
    await client.related(
      { indexes, content: ['docs'], file_path: 'a.md', line: 3, top_k: 2, max_snippet_lines: 0 },
      signal,
    );
    const reads = answering(200, {
      file_path: 'a.md',
      start_line: 1,
      end_line: 0,
      total_lines: 0,
      text: '',
      truncated: false,
    });
    await createSidecarClient(reads.http).read(
      { key: KEY, file_path: 'a.md', start_line: undefined, end_line: 9, max_lines: 400 },
      signal,
    );
    const sent = [...scripted.requests, ...reads.requests];
    expect(sent.map((request) => [request.method, request.path, request.headers])).toStrictEqual([
      ['POST', '/v1/search', { 'content-type': 'application/json' }],
      ['POST', '/v1/related', { 'content-type': 'application/json' }],
      ['POST', '/v1/read', { 'content-type': 'application/json' }],
    ]);
    expect(sent.map((request) => jsonOf(request))).toStrictEqual([
      {
        indexes,
        content: ['code'],
        query: 'q',
        top_k: 5,
        max_snippet_lines: null,
        languages: ['python'],
      },
      { indexes, content: ['docs'], file_path: 'a.md', line: 3, top_k: 2, max_snippet_lines: 0 },
      { key: KEY, file_path: 'a.md', end_line: 9, max_lines: 400 },
    ]);
  });

  it('ACT-109 lists snapshots and deletes one or every one of an owner, answering the count', async () => {
    const listed = answering(200, {
      snapshots: [META],
      building: [{ key: 'k', owner: 'id-2', started_at: 1 }],
    });
    expect(unwrapOk(await createSidecarClient(listed.http).list(signal)).building).toHaveLength(1);
    const deleted = answering(200, { deleted: 2 });
    const client = createSidecarClient(deleted.http);
    expect(unwrapOk(await client.deleteSnapshot(KEY, signal))).toBe(2);
    expect(unwrapOk(await client.deleteOwner('id-1', signal))).toBe(2);
    expect(
      [...listed.requests, ...deleted.requests].map((request) => [request.method, request.path]),
    ).toStrictEqual([
      ['GET', '/v1/snapshots'],
      ['DELETE', `/v1/snapshots/${KEY}`],
      ['DELETE', '/v1/owners/id-1'],
    ]);
  });
});

describe('the snapshot status (ACT-112)', () => {
  it('ACT-112 reads 200 as ready, 202 as building and 404 snapshot_missing as missing', async () => {
    const ready = unwrapOk(
      await createSidecarClient(answering(200, META).http).status(KEY, signal),
    );
    const building = unwrapOk(
      await createSidecarClient(answering(202, { state: 'building', started_at: 5 }).http).status(
        KEY,
        signal,
      ),
    );
    const missing = unwrapOk(
      await createSidecarClient(
        answering(404, { error: 'snapshot_missing', message: 'x' }).http,
      ).status(KEY, signal),
    );
    expect([ready, building, missing]).toStrictEqual([
      { state: 'ready', meta: META },
      { state: 'building' },
      { state: 'missing' },
    ]);
  });

  it('ACT-113 a status out of shape is a fault and another refusal is handed back', async () => {
    const oddBuilding = unwrapFail(
      await createSidecarClient(answering(202, { state: 'ready' }).http).status(KEY, signal),
    );
    const oddMeta = unwrapFail(
      await createSidecarClient(answering(200, { key: KEY }).http).status(KEY, signal),
    );
    const refused = unwrapFail(
      await createSidecarClient(
        answering(400, { error: 'invalid_request', message: 'x' }).http,
      ).status(KEY, signal),
    );
    expect(
      [oddBuilding, oddMeta].map((error) => error instanceof ActionError && error.detail),
    ).toStrictEqual([
      { reason: 'sidecar_protocol', message: 'GET /v1/snapshots answered out of shape' },
      { reason: 'sidecar_protocol', message: 'GET /v1/snapshots answered out of shape' },
    ]);
    expect(refused instanceof SidecarRefusal && refused.code).toBe('invalid_request');
  });
});

describe('sidecar failures (ACT-113)', () => {
  it("ACT-113 an unreachable sidecar is index_unavailable and the caller's own abort is timeout", async () => {
    const unreachable = unwrapFail(await clientFailing(UNREACHABLE).health(signal));
    const controller = new AbortController();
    controller.abort();
    const aborted = unwrapFail(await clientFailing(new Error('aborted')).health(controller.signal));
    expect(
      [unreachable, aborted].map((error) => error instanceof ActionError && error.code),
    ).toStrictEqual(['index_unavailable', 'timeout']);
  });

  it('ACT-113 an answer past the response cap is a fault, never read on', async () => {
    const error = unwrapFail(await clientFailing(new LocalResponseTooLarge(16)).list(signal));
    expect(error instanceof ActionError && [error.code, error.detail]).toStrictEqual([
      'connector_fault',
      { reason: 'sidecar_protocol', message: 'the answer is too large' },
    ]);
  });

  it('ACT-74 ACT-113 a refusal is its protocol code only; free text or no body is a fault', async () => {
    const refused = unwrapFail(
      await createSidecarClient(
        answering(404, { error: 'path_not_found', message: 'src/secret.ts', detail: { key: KEY } })
          .http,
      ).read({ key: KEY, file_path: 'x', max_lines: 1 }, signal),
    );
    expect(refused).toBeInstanceOf(SidecarRefusal);
    expect(refused instanceof SidecarRefusal && [refused.code, 'detail' in refused]).toStrictEqual([
      'path_not_found',
      false,
    ]);
    const bodies = [
      { error: 'Traceback: src/secret.ts line 3' },
      'not json',
      { message: 'no code' },
    ];
    const faults = [];
    for (const body of bodies) {
      const error = unwrapFail(await createSidecarClient(answering(500, body).http).list(signal));
      faults.push(error instanceof ActionError && error.detail);
    }
    expect(faults).toStrictEqual(
      bodies.map(() => ({ reason: 'sidecar_protocol', message: 'unexpected status 500' })),
    );
  });
});
