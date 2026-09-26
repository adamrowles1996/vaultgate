/**
 * One build per key at a time (ACT-108), within the caps of T46: a second
 * trigger of a key that is building or waiting joins it; a call's build of
 * a ref it named takes a slot at once or is `BUSY` (`tryStart`); every other
 * build waits for one and is never refused (`start`). A build fetches its
 * credential when its slot comes, so one that waits holds none, and one
 * whose target was forgotten meanwhile never downloads. Every build ends in
 * `finished`, once.
 */
import { createBuildSlots, type BuildLimits, type Release } from './build-slots.ts';
import {
  BUSY,
  keyOf,
  withOwnCredential,
  type BuildOutcome,
  type BuildRequest,
  type Builds,
  type BuildsDependencies,
} from './builds.ts';

export interface FlightDependencies extends BuildsDependencies {
  /**
  The caps; `BUILD_LIMITS` unless a test sets its own.
  */
  readonly limits?: BuildLimits;
}

interface Running {
  readonly targetId: string;
  readonly promise: Promise<BuildOutcome>;
  isAbandoned: boolean;
}

/**
What a build forgotten while it waited for its slot ends with; it never started.
*/
const NEVER_STARTED: BuildOutcome = { ok: false, reason: 'target_changed' };

async function attempt(build: () => Promise<BuildOutcome>): Promise<BuildOutcome> {
  try {
    return await build();
  } catch {
    return { ok: false, reason: 'connector_fault' };
  }
}

/**
The builds of this process by key, each until it ends or its target is forgotten.
*/
type Flights = Map<string, Running>;

function launch(
  dependencies: FlightDependencies,
  running: Flights,
  request: BuildRequest,
  work: { readonly build: () => Promise<BuildOutcome>; readonly slot: Promise<Release> },
): Promise<BuildOutcome> {
  const key = keyOf(request);
  const { promise, resolve } = Promise.withResolvers<BuildOutcome>();
  const entry: Running = { targetId: request.targetId, promise, isAbandoned: false };
  running.set(key, entry);
  void (async () => {
    const release = await work.slot;
    const startedAt = dependencies.services.now();
    const outcome = entry.isAbandoned ? NEVER_STARTED : await attempt(work.build);
    release();
    if (running.get(key) === entry) {
      running.delete(key);
    }
    const durationMs = dependencies.services.now() - startedAt;
    dependencies.finished(request, outcome, { durationMs, isAbandoned: entry.isAbandoned });
    resolve(outcome);
  })();
  return promise;
}

function isBuilding(running: Flights, targetId: string): boolean {
  for (const build of running.values()) {
    if (build.targetId === targetId) {
      return true;
    }
  }
  return false;
}

function forget(running: Flights, targetId: string): void {
  for (const [key, build] of running) {
    if (build.targetId !== targetId) {
      continue;
    }
    build.isAbandoned = true;
    running.delete(key);
  }
}

export function createBuilds(dependencies: FlightDependencies): Builds {
  const running: Flights = new Map();
  const slots = createBuildSlots(dependencies.limits);
  const build = (request: BuildRequest) => (): Promise<BuildOutcome> =>
    withOwnCredential(dependencies, request);
  return {
    start: (request) =>
      running.get(keyOf(request))?.promise ??
      launch(dependencies, running, request, { build: build(request), slot: slots.take() }),
    tryStart(request) {
      const joined = running.get(keyOf(request))?.promise;
      if (joined !== undefined) {
        return joined;
      }
      const slot = slots.tryTake(request.targetId);
      return slot === undefined
        ? BUSY
        : launch(dependencies, running, request, {
            build: build(request),
            slot: Promise.resolve(slot),
          });
    },
    isBuilding: (targetId) => isBuilding(running, targetId),
    forget: (targetId) => {
      forget(running, targetId);
    },
  };
}
