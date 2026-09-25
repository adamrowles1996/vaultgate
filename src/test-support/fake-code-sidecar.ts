/**
 * The code sidecar (`sidecars/code/PROTOCOL.md`) behind the `LocalHttp`
 * seam, in memory: snapshots keyed as vaultgate keys them, builds that read
 * the whole streamed archive and can be held open (`hold`) to test single
 * flight and the ACT-112 wait, search and related queries answered from a
 * per-test `answer`, and reads from a per-test file table. It records every
 * build's spec, the bytes it received and each query, never the archive.
 */
import type { LocalHttp, LocalRequest, LocalResponse } from '../net/local-http.ts';

export interface FakeSnapshot {
  readonly key: string;
  readonly owner: string;
  readonly commit: string;
  readonly createdAt: number;
  readonly variants: string[];
}

export interface FakeQuery {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface FakeSidecarOptions {
  readonly protocol?: number;
  /**
  The results of every search and related query.
  */
  readonly answer?: (query: FakeQuery) => readonly Record<string, unknown>[];
  /**
  File text by path, for reads; a path absent here is `path_not_found`.
  */
  readonly files?: Readonly<Record<string, string>>;
  /**
  A refusal the next build answers with (`archive_too_large`, `build_timeout`…).
  */
  readonly buildError?: string;
  readonly now?: () => number;
}

export interface FakeSidecar {
  readonly http: LocalHttp;
  readonly snapshots: Map<string, FakeSnapshot>;
  readonly builds: { readonly key: string; readonly spec: unknown; readonly bytes: number }[];
  readonly queries: FakeQuery[];
  /**
  Holds every build open until the returned function is called.
  */
  hold(): () => void;
  /**
  Makes the next request fail as if nothing listened on the socket.
  */
  unreachable(isUnreachable: boolean): void;
}

function respond(status: number, body: unknown): LocalResponse {
  return { status, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

function refusal(status: number, error: string, detail?: Record<string, unknown>): LocalResponse {
  return respond(status, { error, message: error, ...(detail !== undefined && { detail }) });
}

function metaOf(snapshot: FakeSnapshot) {
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

async function drain(body: LocalRequest['body']): Promise<number> {
  if (body === undefined || Buffer.isBuffer(body)) {
    return body?.byteLength ?? 0;
  }
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
  }
  return total;
}

function jsonBody(request: LocalRequest): Record<string, unknown> {
  return Buffer.isBuffer(request.body)
    ? (JSON.parse(request.body.toString('utf8')) as Record<string, unknown>)
    : {};
}

export function createFakeSidecar(options: FakeSidecarOptions = {}): FakeSidecar {
  const snapshots = new Map<string, FakeSnapshot>();
  const builds: FakeSidecar['builds'] = [];
  const queries: FakeQuery[] = [];
  const now = options.now ?? (() => 1_790_000_000_000);
  let gate: Promise<undefined> | undefined;
  let isUnreachable = false;
  let buildError = options.buildError;

  async function build(request: LocalRequest, key: string): Promise<LocalResponse> {
    const header = request.headers?.['x-vaultgate-build'] ?? '';
    const spec = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      owner: string;
      commit: string;
      variants: string[][];
    };
    const bytes = await drain(request.body);
    builds.push({ key, spec, bytes });
    await gate;
    if (buildError !== undefined) {
      const error = buildError;
      buildError = undefined;
      return refusal(422, error, { files: 0 });
    }
    const snapshot: FakeSnapshot = {
      key,
      owner: spec.owner,
      commit: spec.commit,
      createdAt: now(),
      variants: spec.variants.map((variant) => variant.join('+')),
    };
    snapshots.set(key, snapshot);
    return respond(200, metaOf(snapshot));
  }

  function query(request: LocalRequest, path: string): LocalResponse {
    const body = jsonBody(request);
    queries.push({ path, body });
    const indexes = body['indexes'] as { key: string }[];
    const missing = indexes.find((index) => !snapshots.has(index.key));
    if (missing !== undefined) {
      return refusal(404, 'snapshot_missing', { key: missing.key });
    }
    const results = options.answer?.({ path, body }) ?? [];
    return path === '/v1/related' && results.length === 0
      ? refusal(404, 'chunk_not_found')
      : respond(200, { results, variants: [] });
  }

  function read(request: LocalRequest): LocalResponse {
    const body = jsonBody(request);
    queries.push({ path: '/v1/read', body });
    if (!snapshots.has(String(body['key']))) {
      return refusal(404, 'snapshot_missing', { key: body['key'] });
    }
    const text = options.files?.[String(body['file_path'])];
    if (text === undefined) {
      return refusal(404, 'path_not_found');
    }
    if (text.includes('\0')) {
      return refusal(422, 'not_text');
    }
    const lines = text.split('\n');
    const start = Number(body['start_line'] ?? 1);
    const end = Math.min(
      Number(body['end_line'] ?? lines.length),
      lines.length,
      start + Number(body['max_lines']) - 1,
    );
    return respond(200, {
      file_path: body['file_path'],
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      text: lines.slice(start - 1, end).join('\n'),
      truncated: end < Math.min(Number(body['end_line'] ?? lines.length), lines.length),
    });
  }

  function listed(): FakeSnapshot[] {
    return [...snapshots].map(([, snapshot]) => snapshot);
  }

  function snapshotRoute(
    request: LocalRequest,
    key: string,
  ): Promise<LocalResponse> | LocalResponse {
    if (request.method === 'PUT') {
      return build(request, key);
    }
    if (request.method === 'DELETE') {
      return respond(200, { deleted: snapshots.delete(key) ? 1 : 0 });
    }
    if (key === '') {
      const all = listed().map((snapshot) => metaOf(snapshot));
      return respond(200, { snapshots: all, building: [] });
    }
    const found = snapshots.get(key);
    return found === undefined ? refusal(404, 'snapshot_missing') : respond(200, metaOf(found));
  }

  function ownerRoute(owner: string): LocalResponse {
    const owned = listed().filter((snapshot) => snapshot.owner === owner);
    for (const snapshot of owned) {
      snapshots.delete(snapshot.key);
    }
    return respond(200, { deleted: owned.length });
  }

  function route(request: LocalRequest): Promise<LocalResponse> | LocalResponse {
    const [kind, argument = ''] = request.path.split('/').slice(2);
    switch (kind) {
      case 'health': {
        return respond(200, {
          protocol: options.protocol ?? 1,
          semble: '0.6.1',
          model: 'minishlab/potion-code-16M-v2',
          model_revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
        });
      }
      case 'snapshots': {
        return snapshotRoute(request, decodeURIComponent(argument));
      }
      case 'owners': {
        return ownerRoute(decodeURIComponent(argument));
      }
      case 'read': {
        return read(request);
      }
      default: {
        return query(request, request.path);
      }
    }
  }

  const http: LocalHttp = async (request) => {
    if (isUnreachable) {
      throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    }
    return route(request);
  };

  return {
    http,
    snapshots,
    builds,
    queries,
    hold() {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve(undefined);
      };
    },
    unreachable(value) {
      isUnreachable = value;
    },
  };
}
