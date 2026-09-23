import { type Clock, MS_PER_MINUTE, MS_PER_SECOND } from './primitives.ts';

import type { LoginAttemptsStore } from './repositories/login-attempts.ts';
import type { OperatorRecord } from './repositories/operators.ts';

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

/**
The account as the login form names it (ID-13): pass the address as `normaliseEmail` returns it.
*/
export function emailSubject(email: string): string {
  return `email:${email}`;
}

/**
An account that predates e-mail identification (ID-26) is counted by its id instead.
*/
export function operatorSubject(operatorId: string): string {
  return `operator:${operatorId}`;
}

export function accountSubject(operator: Pick<OperatorRecord, 'id' | 'email'>): string {
  return operator.email === undefined ? operatorSubject(operator.id) : emailSubject(operator.email);
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
