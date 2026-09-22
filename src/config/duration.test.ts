import { describe, expect, it } from 'vitest';

import { durationSchema, parseDuration } from './duration.ts';

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['7d', 604_800_000],
    [' 2m ', 120_000],
  ])('parses %s', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each(['', 'm', '5', '5x', '-5m', '5.5m', 'five m', '5 m'])('rejects %j', (text) => {
    expect(parseDuration(text)).toBeUndefined();
  });
});

describe('durationSchema', () => {
  const schema = durationSchema({ min: '1m', max: '1h', fallback: '15m' });

  it('applies the fallback when the value is absent', () => {
    expect(schema.parse(undefined)).toBe(900_000);
  });

  it('yields milliseconds for a valid value', () => {
    expect(schema.parse('30m')).toBe(1_800_000);
  });

  it('reports a malformed value with the received text', () => {
    const result = schema.safeParse('soon');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('received "soon"');
  });

  it('enforces the lower and upper bounds', () => {
    expect(schema.safeParse('30s').error?.issues[0]?.message).toBe('must be at least 1m');
    expect(schema.safeParse('2h').error?.issues[0]?.message).toBe('must be at most 1h');
  });

  it('refuses to build a schema from malformed bounds', () => {
    expect(() => durationSchema({ min: 'x', max: '1h', fallback: '1m' })).toThrow(
      'minimum duration "x" is malformed',
    );
    expect(() => durationSchema({ min: '1m', max: 'y', fallback: '1m' })).toThrow(
      'maximum duration "y" is malformed',
    );
  });
});
