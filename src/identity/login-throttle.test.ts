import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../test-support/database.ts';

import {
  accountSubject,
  backoffDelayMs,
  createLoginThrottle,
  emailSubject,
  ipSubject,
  operatorSubject,
} from './login-throttle.ts';
import { createLoginAttemptsStore } from './repositories/login-attempts.ts';

describe('backoffDelayMs', () => {
  it('ID-13 is free for five failures then doubles from 1 s to a 60 s cap', () => {
    expect(
      [0, 4, 5, 6, 7, 10, 11, 12, 100].map((failures) => backoffDelayMs(failures)),
    ).toStrictEqual([0, 0, 1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000]);
  });
});

describe('createLoginThrottle', () => {
  it('ID-13 delays by the worst subject and forgets failures after 15 minutes', () => {
    let now = 1_000_000;
    const attempts = createLoginAttemptsStore(openTestDatabase());
    const throttle = createLoginThrottle(attempts, () => now);
    const subjects = [ipSubject('203.0.113.7'), operatorSubject('op-1')];
    expect(throttle.delayFor(subjects)).toBe(0);
    for (let failure = 0; failure < 5; failure += 1) {
      throttle.record(subjects, false);
    }
    throttle.record([ipSubject('203.0.113.7')], false);
    expect(throttle.delayFor([operatorSubject('op-1')])).toBe(1000);
    expect(throttle.delayFor(subjects)).toBe(2000);
    expect(throttle.delayFor([])).toBe(0);
    now += 15 * 60_000;
    expect(throttle.delayFor(subjects)).toBe(0);
  });

  it('ID-13 names unknown addresses without failing', () => {
    expect(ipSubject(undefined)).toBe('ip:unknown');
  });

  it('ID-13 ID-26 counts an account by its e-mail, or by its id before one is set', () => {
    expect(emailSubject('ada@example.com')).toBe('email:ada@example.com');
    expect(accountSubject({ id: 'op-1', email: 'ada@example.com' })).toBe('email:ada@example.com');
    expect(accountSubject({ id: 'op-1', email: undefined })).toBe('operator:op-1');
  });
});
