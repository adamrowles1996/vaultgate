import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../test-support/manual-clock.ts';

import { sleep, systemClock } from './clock.ts';

describe('systemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the wall clock and runs scheduled callbacks after the delay', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    expect(systemClock.now()).toBe(1_000_000);
    const callback = vi.fn();
    systemClock.schedule(callback, 500);
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels a scheduled callback', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const cancel = systemClock.schedule(callback, 500);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('sleep', () => {
  it('QG-2 settles as elapsed once the clock reaches the delay', async () => {
    const clock = new ManualClock();
    const { done } = sleep(clock, 250);
    await clock.advance(250);
    await expect(done).resolves.toBe('elapsed');
  });

  it('settles as cancelled immediately when cancelled', async () => {
    const clock = new ManualClock();
    const { done, cancel } = sleep(clock, 250);
    cancel();
    await expect(done).resolves.toBe('cancelled');
    expect(clock.pending()).toBe(0);
  });
});

describe('ManualClock', () => {
  it('fires due timers in order and moves time to the end of the advance', async () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    const record = (label: string) => () => {
      fired.push(label);
    };
    clock.schedule(record('late'), 300);
    clock.schedule(record('early'), 100);
    clock.schedule(record('never'), 1000);
    await clock.advance(500);
    expect(fired).toStrictEqual(['early', 'late']);
    expect(clock.now()).toBe(500);
    expect(clock.pending()).toBe(1);
  });

  it('ignores a cancel after the timer has fired', async () => {
    const clock = new ManualClock(0);
    const cancel = clock.schedule(vi.fn(), 10);
    await clock.advance(10);
    cancel();
    expect(clock.pending()).toBe(0);
  });
});
