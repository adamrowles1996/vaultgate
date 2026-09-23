import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { VERSION } from './version.ts';

describe('VERSION', () => {
  it('ACT-80 is the package.json version, so the User-Agent and initialize report the release', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
