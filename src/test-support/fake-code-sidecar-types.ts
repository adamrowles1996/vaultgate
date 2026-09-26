/**
 * The shapes of the fake code sidecar (`./fake-code-sidecar.ts`): what a
 * test configures, what the fake records and what it lets a test do.
 */
import type { BuildSpecSeen, FakeSnapshot, Route } from './fake-code-sidecar-protocol.ts';
import type { LocalHttp, LocalResponse } from '../net/local-http.ts';

export interface FakeQuery {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

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
  /**
  Snapshots the sidecar already holds when it starts, as a restarted vaultgate finds them.
  */
  readonly seed?: readonly FakeSnapshot[];
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
  /**
  Uploads whose stream failed part way, with how much of it arrived.
  */
  readonly cut: { readonly key: string; readonly bytes: number }[];
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

export interface Running {
  readonly owner: string;
  readonly startedAt: number;
  isAbandoned: boolean;
}
