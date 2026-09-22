import { scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { fail, ok, type Result } from '../result.ts';

import { isCommonPassword } from './common-passwords.ts';

import type { RandomSource } from './primitives.ts';

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;

const SALT_BYTES = 32;
const HASH_BYTES = 64;
const FIELD_COUNT = 6;

export interface ScryptParameters {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

/**
Current parameters (ID-6). Raising them here upgrades every hash on next login.
*/
export const CURRENT_PARAMETERS: ScryptParameters = { cost: 2 ** 17, blockSize: 8, parallelism: 1 };

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
Length rules and the common-password list (ID-5); no composition rules.
*/
export function checkPasswordPolicy(password: string): Result<string, PasswordPolicyError> {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return fail(new PasswordPolicyError(`use at least ${PASSWORD_MIN_LENGTH} characters`));
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return fail(new PasswordPolicyError(`use at most ${PASSWORD_MAX_LENGTH} characters`));
  }
  return isCommonPassword(password)
    ? fail(new PasswordPolicyError('that password is on the list of most common passwords'))
    : ok(password);
}

const scryptAsync = promisify<string, Buffer, number, ScryptOptions, Buffer>(scrypt);

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  const { cost, blockSize, parallelism } = parameters;
  const maxmem = 2 * 128 * cost * blockSize * parallelism;
  return scryptAsync(password, salt, HASH_BYTES, { N: cost, r: blockSize, p: parallelism, maxmem });
}

/**
Hashes with scrypt and encodes as `scrypt$N$r$p$salt$hash` (ID-6).
*/
export async function hashPassword(
  password: string,
  random: RandomSource,
  parameters: ScryptParameters = CURRENT_PARAMETERS,
): Promise<string> {
  const salt = random(SALT_BYTES);
  const hash = await derive(password, salt, parameters);
  const { cost, blockSize, parallelism } = parameters;
  const encoded = [salt, hash].map((part) => part.toString('base64'));
  return ['scrypt', cost, blockSize, parallelism, ...encoded].join('$');
}

interface StoredHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function positiveInteger(text: string | undefined): number | undefined {
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseStoredHash(stored: string): StoredHash | undefined {
  const fields = stored.split('$');
  if (fields.length !== FIELD_COUNT || fields[0] !== 'scrypt') {
    return undefined;
  }
  const cost = positiveInteger(fields[1]);
  const blockSize = positiveInteger(fields[2]);
  const parallelism = positiveInteger(fields[3]);
  if (cost === undefined || blockSize === undefined || parallelism === undefined) {
    return undefined;
  }
  return {
    parameters: { cost, blockSize, parallelism },
    salt: Buffer.from(String(fields[4]), 'base64'),
    hash: Buffer.from(String(fields[5]), 'base64'),
  };
}

/**
Constant-time comparison against a stored hash (ID-7); malformed input is a mismatch.
*/
export async function isCorrectPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed?.hash.length !== HASH_BYTES) {
    return false;
  }
  const candidate = await derive(password, parsed.salt, parsed.parameters);
  return timingSafeEqual(candidate, parsed.hash);
}

/**
True when the stored hash uses weaker parameters than `current` or is unreadable (ID-6).
*/
export function requiresRehash(
  stored: string,
  current: ScryptParameters = CURRENT_PARAMETERS,
): boolean {
  const parsed = parseStoredHash(stored);
  if (parsed === undefined) {
    return true;
  }
  const { cost, blockSize, parallelism } = parsed.parameters;
  return cost < current.cost || blockSize < current.blockSize || parallelism < current.parallelism;
}
