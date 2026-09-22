import { type Clock, MS_PER_MINUTE, MS_PER_SECOND } from './primitives.ts';

import type { LoginAttemptsStore } from './repositories/login-attempts.ts';

const THROTTLE_FREE_FAILURES = 5;
const THROTTLE_WINDOW_MS = 15 * MS_PER_MINUTE;
const MAX_DELAY_MS = 60 * MS_PER_SECOND;

/**
Zero for the first five failures, then 1 s, 2 s, 4 s … capped at 60 s (ID-13). Never a lockout.
*/
export function backoffDelayMs(failures: number): number {
  return failures < THROTTLE_FREE_FAILURES
    ? 0
    : Math.min(MAX_DELAY_MS, MS_PER_SECOND * 2 ** (failures - THROTTLE_FREE_FAILURES));
}

export interface LoginThrottle {
  /**
  The delay to impose before answering, from the worst of the subjects.
  */
  delayFor(subjects: readonly string[]): number;
  record(subjects: readonly string[], didSucceed: boolean): void;
}

export function ipSubject(ip: string | undefined): string {
  return `ip:${ip ?? 'unknown'}`;
}

export function operatorSubject(operatorId: string): string {
  return `operator:${operatorId}`;
}

export function createLoginThrottle(attempts: LoginAttemptsStore, clock: Clock): LoginThrottle {
  return {
    delayFor: (subjects) => {
      const since = clock() - THROTTLE_WINDOW_MS;
      const failures = subjects.map((subject) => attempts.countFailuresSince(subject, since));
      return backoffDelayMs(Math.max(0, ...failures));
    },
    record: (subjects, didSucceed) => {
      const now = clock();
      for (const subject of subjects) {
        attempts.record(subject, now, didSucceed);
      }
    },
  };
}
