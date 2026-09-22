import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSecretFileFromDisk, resolveSecretFiles, type SecretFile } from './secret-files.ts';

describe('readSecretFileFromDisk', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'vaultgate-secret-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads the value, drops one trailing newline and reports a private mode', () => {
    const path = join(directory, 'password');
    writeFileSync(path, 'hunter2\n', { mode: 0o600 });
    expect(readSecretFileFromDisk(path)).toStrictEqual({ value: 'hunter2', worldReadable: false });
  });

  it('keeps interior newlines and flags a world-readable file', () => {
    const path = join(directory, 'key');
    writeFileSync(path, 'line1\nline2\r\n');
    chmodSync(path, 0o644);
    expect(readSecretFileFromDisk(path)).toStrictEqual({
      value: 'line1\nline2',
      worldReadable: true,
    });
  });

  it('throws for a missing file', () => {
    expect(() => readSecretFileFromDisk(join(directory, 'missing'))).toThrow(/ENOENT/);
  });
});

function throwNonError(): SecretFile {
  throw 'disk on fire'; // eslint-disable-line @typescript-eslint/only-throw-error -- exercises the non-Error path
}

describe('resolveSecretFiles', () => {
  const files: Record<string, SecretFile> = {
    '/run/secrets/bw_password': { value: 'from-file', worldReadable: false },
    '/etc/vaultgate/key': { value: 'key-material', worldReadable: true },
  };
  const reader = (path: string): SecretFile => {
    const file = files[path];
    if (file === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return file;
  };

  it('leaves the environment untouched when no _FILE variable is set', () => {
    const environment = { VAULTGATE_BW_PASSWORD: 'inline' };
    expect(resolveSecretFiles(environment, reader)).toStrictEqual({
      environment,
      issues: [],
      warnings: [],
    });
  });

  it('replaces the value from the file and warns about permissive modes', () => {
    const result = resolveSecretFiles(
      {
        VAULTGATE_BW_PASSWORD: 'inline',
        VAULTGATE_BW_PASSWORD_FILE: '/run/secrets/bw_password',
        VAULTGATE_SECRET_KEY_FILE: '/etc/vaultgate/key',
      },
      reader,
    );
    expect(result.environment['VAULTGATE_BW_PASSWORD']).toBe('from-file');
    expect(result.environment['VAULTGATE_SECRET_KEY']).toBe('key-material');
    expect(result.issues).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      'VAULTGATE_SECRET_KEY_FILE: /etc/vaultgate/key is world-readable; restrict it to the service user',
    ]);
  });

  it('reports an unreadable file as an issue and keeps going', () => {
    const result = resolveSecretFiles(
      {
        VAULTGATE_BW_CLIENT_SECRET_FILE: '/nowhere',
        VAULTGATE_BOOTSTRAP_TOKEN_FILE: '/run/secrets/bw_password',
      },
      reader,
    );
    expect(result.issues).toStrictEqual([
      'VAULTGATE_BW_CLIENT_SECRET_FILE: cannot read /nowhere (ENOENT: /nowhere)',
    ]);
    expect(result.environment['VAULTGATE_BOOTSTRAP_TOKEN']).toBe('from-file');
  });

  it('stringifies non-Error failures', () => {
    const result = resolveSecretFiles({ VAULTGATE_SECRET_KEY_FILE: '/x' }, throwNonError);
    expect(result.issues).toStrictEqual([
      'VAULTGATE_SECRET_KEY_FILE: cannot read /x (disk on fire)',
    ]);
  });
});
