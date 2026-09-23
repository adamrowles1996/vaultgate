/**
 * Injection points shared by the identity modules. Production wires
 * `node:crypto` and `Date.now`; tests wire deterministic doubles so no test
 * depends on entropy or the wall clock (QG-2).
 */
import type { RandomSource } from '../crypto/secret-box.ts';

export type { RandomSource } from '../crypto/secret-box.ts';

export type Clock = () => number;

/**
An awaited pause, injected so the login backoff is testable without sleeping.
*/
export type Delay = (ms: number) => Promise<void>;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const UUID_BYTES = 16;
const UUID_VERSION_INDEX = 6;
const UUID_VARIANT_INDEX = 8;

/**
A version 4 UUID drawn from the injected random source (the store's id convention).
*/
export function randomUuid(random: RandomSource): string {
  const bytes = Buffer.from(random(UUID_BYTES));
  bytes.writeUInt8((bytes.readUInt8(UUID_VERSION_INDEX) & 0x0f) | 0x40, UUID_VERSION_INDEX);
  bytes.writeUInt8((bytes.readUInt8(UUID_VARIANT_INDEX) & 0x3f) | 0x80, UUID_VARIANT_INDEX);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
