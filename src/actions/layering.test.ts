import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const CRUISER = readFileSync(join(ROOT, '.dependency-cruiser.mjs'), 'utf8');

describe('actions layering', () => {
  it('ACT-69 lays the engine out as the specification names it', () => {
    const files = [
      'engine.ts',
      'targets.ts',
      'policy.ts',
      'confirm.ts',
      'scrub.ts',
      'limits.ts',
      'sessions.ts',
      'connectors/connector.ts',
      'connectors/registry.ts',
      'connectors/http/schemas.ts',
      'connectors/http/index.ts',
    ];
    expect(files.filter((file) => !existsSync(join(ROOT, 'src', 'actions', file)))).toStrictEqual(
      [],
    );
  });

  it('ACT-70 the module-graph rules forbid actions/ from oauth/, bitwarden/ and http/, allow identity/ and mcp/ types only, and keep the features out of actions/', () => {
    expect(CRUISER).toContain(
      "from: { path: '^src/actions/' },\n      to: { path: '^src/(oauth|bitwarden|http)/' },",
    );
    expect(CRUISER).toContain(
      "from: { path: '^src/actions/' },\n      to: {\n        path: '^src/(identity|mcp)/',\n" +
        '        pathNot: [String.raw`^src/identity/pages/(template|icons|ui|console)\\.ts$`],\n' +
        "        dependencyTypesNot: ['type-only'],\n      },",
    );
    expect(CRUISER).toContain(
      "from: { path: '^src/(identity|oauth|bitwarden)/' },\n      to: { path: '^src/actions/' },",
    );
    expect(CRUISER).toContain("to: { path: '^src/(identity|oauth|mcp|bitwarden|actions)/' }");
    expect(CRUISER).toContain(
      "to: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit|actions|http)/' }",
    );
    expect(CRUISER).toContain(
      "from: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit|actions)/' }",
    );
  });

  it('ACT-71 ARCH-2 the module-graph rules forbid child_process anywhere under actions/', () => {
    expect(CRUISER).toContain("to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' }");
    expect(CRUISER).toContain("name: 'actions-never-spawn-a-process'");
  });
});
