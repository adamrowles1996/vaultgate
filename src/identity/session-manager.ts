import { generateCsrfToken } from './csrf.ts';
import {
  generateSessionId,
  hashSessionId,
  isRecentlyReauthenticated,
  nextSessionExpiry,
} from './sessions.ts';

import type { Clock, RandomSource } from './primitives.ts';
import type { SessionRecord, SessionsStore } from './repositories/sessions.ts';

/**
What the rest of the server knows about a browser session (ID-21).
*/
export interface SessionState {
  readonly idHash: string;
  readonly operatorId: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly reauthenticatedAt: number | undefined;
  /**
  True inside the five minute window after a password re-check (ID-15).
  */
  readonly isReauthenticated: boolean;
}

export interface ClientInfo {
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

interface StartedSession {
  /**
  The cookie value; never stored.
  */
  readonly id: string;
  readonly state: SessionState;
}

export interface SessionManager {
  start(operatorId: string, client: ClientInfo): StartedSession;
  /**
  Looks a cookie value up, expiring or refreshing it as ID-14 requires.
  */
  resolve(sessionId: string | undefined): SessionState | undefined;
  end(idHash: string): void;
  endOthers(operatorId: string, keepIdHash: string): number;
  markReauthenticated(idHash: string): void;
  list(operatorId: string): readonly SessionRecord[];
}

export interface SessionManagerDependencies {
  readonly sessions: SessionsStore;
  readonly random: RandomSource;
  readonly clock: Clock;
  readonly absoluteTtlMs: number;
}

function toState(record: SessionRecord, now: number): SessionState {
  return {
    idHash: record.idHash,
    operatorId: record.operatorId,
    csrfToken: record.csrfToken,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    reauthenticatedAt: record.reauthenticatedAt,
    isReauthenticated: isRecentlyReauthenticated(record.reauthenticatedAt, now),
  };
}

export function createSessionManager(dependencies: SessionManagerDependencies): SessionManager {
  const { sessions, random, clock, absoluteTtlMs } = dependencies;
  return {
    start: (operatorId, client) => {
      const now = clock();
      const id = generateSessionId(random);
      const record: SessionRecord = {
        idHash: hashSessionId(id),
        operatorId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: nextSessionExpiry(now, now, absoluteTtlMs),
        reauthenticatedAt: undefined,
        csrfToken: generateCsrfToken(random),
        ip: client.ip,
        userAgent: client.userAgent,
      };
      sessions.insert(record);
      return { id, state: toState(record, now) };
    },
    resolve: (sessionId) => {
      if (sessionId === undefined) {
        return;
      }
      const record = sessions.findByIdHash(hashSessionId(sessionId));
      if (record === undefined) {
        return;
      }
      const now = clock();
      if (record.expiresAt <= now) {
        sessions.delete(record.idHash);
        return;
      }
      const expiresAt = nextSessionExpiry(now, record.createdAt, absoluteTtlMs);
      sessions.touch(record.idHash, now, expiresAt);
      return toState({ ...record, lastSeenAt: now, expiresAt }, now);
    },
    end: (idHash) => {
      sessions.delete(idHash);
    },
    endOthers: (operatorId, keepIdHash) => sessions.deleteOthersForOperator(operatorId, keepIdHash),
    markReauthenticated: (idHash) => {
      sessions.setReauthenticatedAt(idHash, clock());
    },
    list: (operatorId) => sessions.listForOperator(operatorId),
  };
}
