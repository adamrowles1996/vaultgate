import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const CRUISER = readFileSync(join(ROOT, '.dependency-cruiser.mjs'), 'utf8');
const RELAY = join(ROOT, 'src', 'relay');

describe('relay layering', () => {
  it('RELAY-11 the module-graph rules keep relay/ on the vault interface and out of every feature', () => {
    expect(CRUISER).toContain(
      "from: { path: '^src/relay/' },\n      to: { path: '^src/(bitwarden|storage|identity|oauth|mcp|actions|http)/' },",
    );
    expect(CRUISER).toContain(
      "from: { path: '^src/(identity|oauth|mcp|bitwarden|actions|http)/' },\n      to: { path: '^src/relay/' },",
    );
  });

  it('RELAY-11 no relay module reads a secret except through VaultClient.getSecret', () => {
    const runtime = readdirSync(RELAY).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const sources = runtime.map((name) => readFileSync(join(RELAY, name), 'utf8')).join('\n');
    expect(sources).not.toMatch(/from '\.\.\/bitwarden\//);
    expect(sources).not.toMatch(/child_process/);
    expect(sources.match(/\.getSecret\(/g)).toHaveLength(1);
  });
});
