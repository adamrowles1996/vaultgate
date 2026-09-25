/**
 * ACT-109, ACT-115: "whenever vaultgate starts or finds the sidecar reachable
 * again". Every exchange with the sidecar passes through this wrapper, which
 * notes whether it was answered; the first answer after one that was not,
 * and the first answer at all, calls `onReachable`, where the connector
 * checks the protocol and reconciles the snapshots. Nothing polls (ADR 0008):
 * the next call or page that reaches the sidecar is what finds it again. A
 * timeout says nothing either way and changes nothing.
 */
import { ActionError } from '../../errors.ts';

import type { SidecarClient, SidecarOutcome } from './sidecar.ts';

export interface WatchedSidecar {
  readonly client: SidecarClient;
  /**
  Adds a listener told of the first answer, and of every first answer after one that was not.
  */
  onReachable(listener: () => void): void;
}

export function watchReachability(sidecar: SidecarClient): WatchedSidecar {
  const listeners: (() => void)[] = [];
  let isReachable = false;

  function note<T>(outcome: SidecarOutcome<T>): SidecarOutcome<T> {
    const code = !outcome.ok && outcome.error instanceof ActionError ? outcome.error.code : '';
    if (code === 'index_unavailable') {
      isReachable = false;
    } else if (code !== 'timeout' && !isReachable) {
      isReachable = true;
      for (const listener of listeners) {
        listener();
      }
    }
    return outcome;
  }

  const client: SidecarClient = {
    health: async (signal) => note(await sidecar.health(signal)),
    build: async (key, spec, archive, signal) =>
      note(await sidecar.build(key, spec, archive, signal)),
    status: async (key, signal) => note(await sidecar.status(key, signal)),
    list: async (signal) => note(await sidecar.list(signal)),
    deleteSnapshot: async (key, signal) => note(await sidecar.deleteSnapshot(key, signal)),
    deleteOwner: async (owner, signal) => note(await sidecar.deleteOwner(owner, signal)),
    search: async (query, signal) => note(await sidecar.search(query, signal)),
    related: async (query, signal) => note(await sidecar.related(query, signal)),
    read: async (query, signal) => note(await sidecar.read(query, signal)),
  };
  return {
    client,
    onReachable(listener) {
      listeners.push(listener);
    },
  };
}
