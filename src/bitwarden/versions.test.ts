import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  formatVersion,
  MINIMUM_BW_VERSION,
  parseVersion,
  PINNED_BW_VERSION,
} from './versions.ts';

function pinnedIn(file: string, pattern: RegExp): string | undefined {
  return pattern.exec(readFileSync(file, 'utf8'))?.groups?.['version'];
}

describe('parseVersion', () => {
  it('reads major.minor.patch from bw --version output', () => {
    expect(parseVersion('2026.9.0\n')).toStrictEqual({ major: 2026, minor: 9, patch: 0 });
    expect(parseVersion('  v1.22.333-beta')).toStrictEqual({ major: 1, minor: 22, patch: 333 });
  });

  it('returns undefined for anything else', () => {
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion('bw: command not found')).toBeUndefined();
    expect(parseVersion('2026.9')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    const version = { major: 2026, minor: 9, patch: 0 };
    expect(compareVersions(version, { major: 2026, minor: 9, patch: 0 })).toBe(0);
    expect(compareVersions(version, { major: 2025, minor: 12, patch: 9 })).toBeGreaterThan(0);
    expect(compareVersions(version, { major: 2026, minor: 10, patch: 0 })).toBeLessThan(0);
    expect(compareVersions(version, { major: 2026, minor: 9, patch: 1 })).toBeLessThan(0);
  });
});

describe('formatVersion', () => {
  it('round-trips through parseVersion', () => {
    expect(formatVersion({ major: 2026, minor: 9, patch: 0 })).toBe('2026.9.0');
  });
});

describe('version policy', () => {
  it('COMPAT-1 pins the same CLI version as the Dockerfile', () => {
    expect(pinnedIn('Dockerfile', /^ARG BW_VERSION=(?<version>\S+)$/m)).toBe(PINNED_BW_VERSION);
  });

  it('COMPAT-1 pins the same CLI version as install.sh', () => {
    expect(pinnedIn('install.sh', /^BW_VERSION="(?<version>[^"]+)"$/m)).toBe(PINNED_BW_VERSION);
  });

  it('VAULT-2 keeps the minimum at or below the pinned version', () => {
    const minimum = parseVersion(MINIMUM_BW_VERSION);
    const pinned = parseVersion(PINNED_BW_VERSION);
    expect(minimum).toBeDefined();
    expect(pinned).toBeDefined();
    expect(compareVersions(minimum!, pinned!)).toBeLessThanOrEqual(0);
  });
});
