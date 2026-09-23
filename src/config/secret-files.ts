import { readFileSync, statSync } from 'node:fs';

import type { Environment } from './environment.ts';

/**
Variables whose value may be supplied through a `<NAME>_FILE` path instead.
*/
const SECRET_VARIABLES = [
  'VAULTGATE_SECRET_KEY',
  'VAULTGATE_BW_PASSWORD',
  'VAULTGATE_BW_CLIENT_SECRET',
  'VAULTGATE_BOOTSTRAP_TOKEN',
] as const;

export interface SecretFile {
  readonly value: string;
  readonly worldReadable: boolean;
}

export type SecretFileReader = (path: string) => SecretFile;

const WORLD_READABLE_BIT = 0o004;

/**
Reads a secret file, dropping one trailing newline as `echo`-written files have.
*/
export function readSecretFileFromDisk(path: string): SecretFile {
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  const { mode } = statSync(path);
  return { value, worldReadable: (mode & WORLD_READABLE_BIT) !== 0 };
}

export interface ResolvedSecrets {
  readonly environment: Environment;
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies every `<NAME>_FILE` variable: the file's contents replace `<NAME>`.
 * An empty file means unset, as an empty variable does (CFG-1), so a mounted
 * but blank secret file leaves the variable to its default. Unreadable files
 * are reported as issues; world-readable ones as warnings.
 */
export function resolveSecretFiles(
  environment: Environment,
  readSecretFile: SecretFileReader,
): ResolvedSecrets {
  const merged: Record<string, string | undefined> = { ...environment };
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const name of SECRET_VARIABLES) {
    const fileVariable = `${name}_FILE`;
    const path = environment[fileVariable];
    if (path === undefined) {
      continue;
    }
    try {
      const file = readSecretFile(path);
      merged[name] = file.value === '' ? undefined : file.value;
      if (file.worldReadable) {
        warnings.push(
          `${fileVariable}: ${path} is world-readable; restrict it to the service user`,
        );
      }
    } catch (error) {
      issues.push(`${fileVariable}: cannot read ${path} (${describeError(error)})`);
    }
  }
  return { environment: merged, issues, warnings };
}
