/**
 * The relay's `/sync` (RELAY-13): the operator's own sync (VAULT-19), which
 * joins one already running, started for relay callers at most once every
 * `RELAY_SYNC_INTERVAL_MS` whichever node asks. A request inside that window
 * shares the outcome of the sync already started, so a node can pick up a
 * change made elsewhere without being able to drive the vault server.
 */
import type { Result } from '../result.ts';
import type { VaultError } from '../vault/client.ts';

/**
The operator's sync, which the composition layer passes in (RELAY-11).
*/
export type RequestSync = () => Promise<Result<void, VaultError>>;

export interface RelaySyncOutcome {
  readonly result: Result<void, VaultError>;
  /**
  Whether the request shared a sync an earlier request started.
  */
  readonly shared: boolean;
}

export type RelaySync = () => Promise<RelaySyncOutcome>;

/**
RELAY-13: the least time between the starts of two syncs relay callers ask for.
*/
export const RELAY_SYNC_INTERVAL_MS = 10_000;

interface Started {
  readonly at: number;
  readonly result: Promise<Result<void, VaultError>>;
}

export function createRelaySync(requestSync: RequestSync, now: () => number): RelaySync {
  let started: Started | undefined;
  return async () => {
    if (started !== undefined && now() - started.at < RELAY_SYNC_INTERVAL_MS) {
      return { result: await started.result, shared: true };
    }
    const current: Started = { at: now(), result: requestSync() };
    started = current;
    return { result: await current.result, shared: false };
  };
}
