import { describe, expect, it } from 'vitest';

import { BUILD_LIMITS, createBuildSlots } from './build-slots.ts';

describe('the build slots (ACT-108, T46)', () => {
  it('ACT-108 T46 hold at most 2 builds of named refs per target and 4 builds in all by default', () => {
    expect(BUILD_LIMITS).toStrictEqual({ total: 4, perTarget: 2 });
    const slots = createBuildSlots();
    const first = [slots.tryTake('a'), slots.tryTake('a')];
    expect(first.every((slot) => slot !== undefined)).toBe(true);
    expect(slots.tryTake('a')).toBeUndefined();
    const second = [slots.tryTake('b'), slots.tryTake('b')];
    expect(second.every((slot) => slot !== undefined)).toBe(true);
    expect(slots.tryTake('c')).toBeUndefined();
    first[0]?.();
    // A slot given back twice counts once: 'a' has one named build left, 'c' may start one.
    first[0]?.();
    expect(slots.tryTake('c')).toBeDefined();
    expect(slots.tryTake('a')).toBeUndefined();
  });

  it('ACT-108 T46 queue every other build behind the total, in order, and never refuse one', async () => {
    const slots = createBuildSlots({ total: 1, perTarget: 1 });
    const named = slots.tryTake('a');
    const order: string[] = [];
    const queued = async (name: string): Promise<() => void> => {
      const release = await slots.take();
      order.push(name);
      return release;
    };
    const save = queued('save');
    const operator = queued('operator');
    await Promise.resolve();
    expect(order).toStrictEqual([]);
    // A named ref waits for nothing: the total is taken.
    expect(slots.tryTake('b')).toBeUndefined();
    named?.();
    (await save)();
    (await operator)();
    expect(order).toStrictEqual(['save', 'operator']);
    const again = await slots.take();
    expect(slots.tryTake('a')).toBeUndefined();
    again();
    expect(slots.tryTake('a')).toBeDefined();
  });
});
