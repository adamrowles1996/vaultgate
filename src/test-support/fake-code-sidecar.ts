/**
 * The code sidecar (`sidecars/code/PROTOCOL.md`) behind the `LocalHttp`
 * seam, in memory, enforcing the protocol's field lists and identifiers
 * (`./fake-code-sidecar-protocol.ts`): snapshots keyed as vaultgate keys
 * them, builds that read the whole streamed archive and can be held open
 * (`hold`) to test single flight and the ACT-112 wait, search and related
 * answered from a per-test `answer` (merged results prefixed with the label
 * as `semble` merges them), and reads from a per-test file table. Any route
 * can be scripted to refuse, hang until aborted or answer out of shape.
 */
import {
  drain,
  healthAnswer,
  invalid,
  jsonBody,
  KEY,
  LABEL,
  metaOf,
  hasOnlyFields,
  parseSpec,
  READ_FIELDS,
  readAnswer,
  refusal,
  RELATED_FIELDS,
  respond,
  SEARCH_FIELDS,
  variantOf,
  type BuildSpecSeen,
  type FakeSnapshot,
} from './fake-code-sidecar-protocol.ts';

import type { LocalHttp, LocalRequest, LocalResponse } from '../net/local-http.ts';

export type { FakeSnapshot } from './fake-code-sidecar-protocol.ts';

export interface FakeQuery {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export type Route =
  'health' | 'build' | 'status' | 'list' | 'delete' | 'search' | 'related' | 'read';

/**
What the next request of a route gets instead of its answer.
*/
export type Script = LocalResponse | 'hang';

export interface FakeSidecarOptions {
  readonly protocol?: number;
  /**
  The results of every search and related query, each with the `label` of its index.
  */
  readonly answer?: (query: FakeQuery) => readonly Record<string, unknown>[];
  /**
  File text by path, for reads; a path absent here is `path_not_found`.
  */
  readonly files?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

export interface FakeBuild {
  readonly key: string;
  readonly spec: BuildSpecSeen;
  readonly archive: Buffer;
}

export interface FakeSidecar {
  readonly http: LocalHttp;
  readonly snapshots: Map<string, FakeSnapshot>;
  readonly builds: FakeBuild[];
  readonly queries: FakeQuery[];
  readonly requests: { readonly method: string; readonly path: string }[];
  /**
  Holds every build open until the returned function is called.
  */
  hold(): () => void;
  /**
  Makes every request fail as if nothing listened on the socket, until turned off.
  */
  unreachable(isUnreachable: boolean): void;
  /**
  The next request of `route` gets `script` instead of its answer.
  */
  script(route: Route, script: Script): void;
}

interface Running {
  readonly owner: string;
  readonly startedAt: number;
  isAbandoned: boolean;
}

function routeOf(request: LocalRequest): { readonly route: Route; readonly argument: string } {
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

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export function createFakeSidecar(options: FakeSidecarOptions = {}): FakeSidecar {
  const snapshots = new Map<string, FakeSnapshot>();
  const running = new Map<string, Running>();
  const pending = new Map<string, Promise<LocalResponse>>();
  const builds: FakeBuild[] = [];
  const queries: FakeQuery[] = [];
  const requests: FakeSidecar['requests'] = [];
  const scripts = new Map<Route, Script[]>();
  const now = options.now ?? (() => 1_790_000_000_000);
  let gate: Promise<undefined> | undefined;
  let isUnreachable = false;

  async function finish(key: string, spec: BuildSpecSeen, entry: Running): Promise<LocalResponse> {
    await gate;
    running.delete(key);
    pending.delete(key);
    if (entry.isAbandoned) {
      return refusal(404, 'snapshot_missing');
    }
    const variants = spec.variants.map((variant) => variantOf(variant) ?? '');
    const snapshot = { key, owner: spec.owner, commit: spec.commit, createdAt: now(), variants };
    snapshots.set(key, snapshot);
    return respond(200, metaOf(snapshot));
  }

  async function build(request: LocalRequest, key: string): Promise<LocalResponse> {
    const spec = parseSpec(request.headers?.['x-vaultgate-build']);
    if (spec === undefined || !KEY.test(key)) {
      return invalid();
    }
    const existing = snapshots.get(key);
    if (existing !== undefined) {
      return respond(200, metaOf(existing));
    }
    const joined = pending.get(key);
    const archive = await drain(request.body);
    if (joined !== undefined) {
      return joined;
    }
    builds.push({ key, spec, archive });
    const entry: Running = { owner: spec.owner, startedAt: now(), isAbandoned: false };
    running.set(key, entry);
    const done = finish(key, spec, entry);
    pending.set(key, done);
    return done;
  }

  function remove(argument: string): LocalResponse {
    const owner = argument.startsWith('owner:') ? argument.slice('owner:'.length) : undefined;
    const doomed = [
      ...snapshots.values(),
      ...[...running].map(([key, value]) => ({ key, ...value })),
    ]
      .filter((entry) => (owner === undefined ? entry.key === argument : entry.owner === owner))
      .map((entry) => entry.key);
    for (const key of doomed) {
      const build = running.get(key);
      if (build !== undefined) {
        build.isAbandoned = true;
      }
    }
    const deleted = doomed.filter((key) => snapshots.delete(key)).length;
    return respond(200, { deleted });
  }

  function query(body: Record<string, unknown>, path: string): LocalResponse {
    const indexes = body['indexes'] as { readonly key: string; readonly label: string }[];
    const variant = variantOf(body['content']);
    const isValid =
      Array.isArray(indexes) &&
      indexes.length > 0 &&
      indexes.every((index) => KEY.test(index.key) && LABEL.test(index.label)) &&
      variant !== undefined;
    if (!isValid) {
      return invalid();
    }
    const missing = indexes.find((index) => !snapshots.has(index.key));
    if (missing !== undefined) {
      return refusal(404, 'snapshot_missing');
    }
    queries.push({ path, body });
    const isMerged = indexes.length > 1;
    const results = (options.answer?.({ path, body }) ?? []).map((result) =>
      isMerged
        ? { ...result, file_path: `${String(result['label'])}/${String(result['file_path'])}` }
        : result,
    );
    return path === '/v1/related' && results.length === 0
      ? refusal(404, 'chunk_not_found')
      : respond(200, { results, variants: [] });
  }

  function read(body: Record<string, unknown>): LocalResponse {
    queries.push({ path: '/v1/read', body });
    if (!snapshots.has(String(body['key']))) {
      return refusal(404, 'snapshot_missing');
    }
    const text = options.files?.[String(body['file_path'])];
    return text === undefined ? refusal(404, 'path_not_found') : readAnswer(body, text);
  }

  function health(): LocalResponse {
    return healthAnswer(options.protocol ?? 1, snapshots.size, running.size);
  }

  function status(key: string): LocalResponse {
    const found = snapshots.get(key);
    if (found !== undefined) {
      return respond(200, metaOf(found));
    }
    const build = running.get(key);
    return build === undefined
      ? refusal(404, 'snapshot_missing')
      : respond(202, { state: 'building', started_at: build.startedAt });
  }

  function list(): LocalResponse {
    const building = [...running].map(([key, build]) => ({
      key,
      owner: build.owner,
      started_at: build.startedAt,
    }));
    return respond(200, {
      snapshots: Array.from(snapshots.values(), (snapshot) => metaOf(snapshot)),
      building,
    });
  }

  function answerOf(request: LocalRequest, route: Route, argument: string) {
    const body = jsonBody(request) ?? {};
    const handlers: Readonly<Record<Route, () => Promise<LocalResponse> | LocalResponse>> = {
      health,
      build: () => build(request, argument),
      status: () => status(argument),
      list,
      delete: () => remove(argument),
      search: () => (hasOnlyFields(body, SEARCH_FIELDS) ? query(body, '/v1/search') : invalid()),
      related: () => (hasOnlyFields(body, RELATED_FIELDS) ? query(body, '/v1/related') : invalid()),
      read: () => (hasOnlyFields(body, READ_FIELDS) ? read(body) : invalid()),
    };
    return handlers[route]();
  }

  const http: LocalHttp = async (request) => {
    requests.push({ method: request.method, path: request.path });
    if (isUnreachable) {
      throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    }
    const { route, argument } = routeOf(request);
    const scripted = scripts.get(route)?.shift();
    return scripted === 'hang'
      ? untilAborted(request.signal)
      : (scripted ?? answerOf(request, route, argument));
  };

  return {
    http,
    snapshots,
    builds,
    queries,
    requests,
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
    script(route, script) {
      scripts.set(route, [...(scripts.get(route) ?? []), script]);
    },
  };
}
