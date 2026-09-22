import { z } from 'zod';

const UNIT_MILLISECONDS: ReadonlyMap<string, number> = new Map([
  ['s', 1000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
]);

const DIGITS = /^\d+$/;

/**
Parses `<number><s|m|h|d>` into milliseconds; `undefined` when malformed.
*/
export function parseDuration(text: string): number | undefined {
  const trimmed = text.trim();
  const multiplier = UNIT_MILLISECONDS.get(trimmed.slice(-1));
  const amount = trimmed.slice(0, -1);
  return multiplier === undefined || !DIGITS.test(amount) ? undefined : Number(amount) * multiplier;
}

export interface DurationBounds {
  readonly min: string;
  readonly max: string;
  readonly fallback: string;
}

function requireDuration(text: string, label: string): number {
  const value = parseDuration(text);
  if (value === undefined) {
    throw new Error(`${label} duration "${text}" is malformed; use <number><s|m|h|d>`);
  }
  return value;
}

/**
A zod schema reading a duration string and yielding milliseconds within bounds.
*/
export function durationSchema(bounds: DurationBounds): z.ZodType<number, string | undefined> {
  const min = requireDuration(bounds.min, 'minimum');
  const max = requireDuration(bounds.max, 'maximum');
  return z
    .string()
    .default(bounds.fallback)
    .transform((text, context) => {
      const value = parseDuration(text);
      if (value === undefined) {
        context.addIssue({
          code: 'custom',
          message: `must be a duration such as 30s, 5m, 1h or 7d (received "${text}")`,
        });
        return z.NEVER;
      }
      return value;
    })
    .pipe(
      z
        .number()
        .min(min, `must be at least ${bounds.min}`)
        .max(max, `must be at most ${bounds.max}`),
    );
}
