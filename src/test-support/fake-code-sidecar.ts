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
  OWNER,
  hasOnlyFields,
  parseSpec,
  READ_FIELDS,
  readAnswer,
  refusal,
  RELATED_FIELDS,
  respond,
  routeOf,
  type Route,
  SEARCH_FIELDS,
  untilAborted,
  variantOf,
  type BuildSpecSeen,
} from './fake-code-sidecar-protocol.ts';

import type {
  FakeBuild,
  FakeQuery,
  FakeSidecar,
  FakeSidecarOptions,
  Running,
  Script,
} from './fake-code-sidecar-types.ts';
import type { LocalHttp, LocalRequest, LocalResponse } from '../net/local-http.ts';

export type { FakeSnapshot, Route } from './fake-code-sidecar-protocol.ts';
export type {
  FakeQuery,
  FakeSidecar,
  FakeSidecarOptions,
  Script,
} from './fake-code-sidecar-types.ts';

export function createFakeSidecar(options: FakeSidecarOptions = {}): FakeSidecar {
  const snapshots = new Map((options.seed ?? []).map((snapshot) => [snapshot.key, snapshot]));
  const running = new Map<string, Running>();
  const pending = new Map<string, Promise<LocalResponse>>();
  const builds: FakeBuild[] = [];
  const cut: FakeSidecar['cut'] = [];
  const queries: FakeQuery[] = [];
  const requests: FakeSidecar['requests'] = [];
  const scripts = new Map<Route, Script[]>();
  const now = options.now ?? (() => 1_790_000_000_000);
  let gate: Promise<undefined> | undefined;
  let isUnreachable = false;

  async function finish(key: string, spec: BuildSpecSeen, entry: Running): Promise<LocalResponse> {
    await gate;
    if (running.get(key) === entry) {
      running.delete(key);
      pending.delete(key);
    }
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
    const received: Buffer[] = [];
    let archive: Buffer;
    try {
      archive = await drain(request.body, received);
    } catch (error) {
      cut.push({ key, bytes: Buffer.concat(received).length });
      throw error;
    }
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

  /**
  Deletes snapshots and abandons running builds: of one key, or of every key of an owner.
  */
  function remove(isDoomed: (key: string, owner: string) => boolean): LocalResponse {
    const entries = [
      ...Array.from(snapshots.values(), (snapshot) => [snapshot.key, snapshot.owner] as const),
      ...Array.from(running, ([key, build]) => [key, build.owner] as const),
    ];
    const doomed = new Set(
      entries.filter(([key, owner]) => isDoomed(key, owner)).map(([key]) => key),
    );
    let deleted = 0;
    for (const key of doomed) {
      const build = running.get(key);
      if (build !== undefined) {
        build.isAbandoned = true;
        running.delete(key);
        pending.delete(key);
      }
      const wasStored = snapshots.delete(key);
      deleted += build !== undefined || wasStored ? 1 : 0;
    }
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
    return respond(200, { results, variants: [] });
  }

  function read(body: Record<string, unknown>): LocalResponse {
    const isBackwards = Number(body['end_line'] ?? Infinity) < Number(body['start_line'] ?? 1);
    if (!KEY.test(String(body['key']))) {
      return invalid();
    }
    if (isBackwards) {
      return refusal(400, 'invalid_range');
    }
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
    if (!KEY.test(key)) {
      return invalid();
    }
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
      delete: () => (KEY.test(argument) ? remove((key) => key === argument) : invalid()),
      owner: () => (OWNER.test(argument) ? remove((_key, owner) => owner === argument) : invalid()),
      search: () => (hasOnlyFields(body, SEARCH_FIELDS) ? query(body, '/v1/search') : invalid()),
      related: () => (hasOnlyFields(body, RELATED_FIELDS) ? query(body, '/v1/related') : invalid()),
      read: () => (hasOnlyFields(body, READ_FIELDS) ? read(body) : invalid()),
    };
    return handlers[route]();
  }

  const http: LocalHttp = async (request) => {
    requests.push({ method: request.method, path: request.path });
    const routed = routeOf(request);
    const scripted = 'route' in routed ? scripts.get(routed.route)?.shift() : undefined;
    if (isUnreachable || scripted === 'unreachable') {
      throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    }
    if ('refused' in routed) {
      return routed.refused;
    }
    return scripted === 'hang'
      ? untilAborted(request.signal)
      : (scripted ?? answerOf(request, routed.route, routed.argument));
  };

  return {
    http,
    snapshots,
    builds,
    cut,
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
