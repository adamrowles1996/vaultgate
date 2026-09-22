/**
 * Milliseconds since the epoch. Injected everywhere so tests never touch the
 * wall clock (QG-2).
 */
export type Clock = () => number;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

export function toSeconds(milliseconds: number): number {
  return Math.ceil(milliseconds / SECOND_MS);
}
