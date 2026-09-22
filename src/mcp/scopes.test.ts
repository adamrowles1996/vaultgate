import { describe, expect, it } from 'vitest';

import {
  effectiveScopes,
  enabledScopes,
  isToolName,
  missingScopes,
  requiredScopes,
  SCOPE_DEFINITIONS,
  SCOPES,
  TOOL_NAMES,
  TOOL_SCOPES,
  toolsAllowedBy,
} from './scopes.ts';

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('scopes', () => {
  it('OAUTH-36 defines every scope once with a description and marks reveal and write as risky', () => {
    expect(SCOPE_DEFINITIONS.map((definition) => definition.scope)).toStrictEqual([...SCOPES]);
    expect(
      SCOPE_DEFINITIONS.filter((definition) => definition.risk).map((d) => d.scope),
    ).toStrictEqual(['vault:reveal', 'vault:write']);
    expect(SCOPE_DEFINITIONS.every((definition) => definition.description.length > 20)).toBe(true);
  });

  it('OAUTH-16 enables vault:write only when the operator opts in', () => {
    expect(enabledScopes({ enableWriteScope: false })).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
    expect(enabledScopes({ enableWriteScope: true })).toStrictEqual([...SCOPES]);
  });

  it('§6.2 maps every tool to exactly one scope', () => {
    expect(Object.keys(TOOL_SCOPES).toSorted(byName)).toStrictEqual(TOOL_NAMES.toSorted(byName));
    expect(isToolName('get_secret')).toBe(true);
    expect(isToolName('drop_vault')).toBe(false);
  });

  it('§6.2 requires vault:reveal as well when a write carries an explicit password', () => {
    expect(requiredScopes('update_item', { item_id: 'x', password: 'pw' })).toStrictEqual([
      'vault:write',
      'vault:reveal',
    ]);
    expect(requiredScopes('create_item', { name: 'x', password: 'pw' })).toStrictEqual([
      'vault:write',
      'vault:reveal',
    ]);
    expect(requiredScopes('update_item', { item_id: 'x', generate_password: true })).toStrictEqual([
      'vault:write',
    ]);
    expect(requiredScopes('update_item', { item_id: 'x', password: 42 })).toStrictEqual([
      'vault:write',
    ]);
    expect(requiredScopes('update_item', null)).toStrictEqual(['vault:write']);
    expect(requiredScopes('update_item', 'password')).toStrictEqual(['vault:write']);
    expect(requiredScopes('get_secret', { password: 'pw' })).toStrictEqual(['vault:reveal']);
  });

  it('OAUTH-16 narrows held scopes to the enabled set and reports what is missing', () => {
    const effective = effectiveScopes(
      ['vault:write', 'vault:read', 'offline_access'],
      enabledScopes({ enableWriteScope: false }),
    );
    expect(effective).toStrictEqual(['vault:read']);
    expect(missingScopes(['vault:write', 'vault:reveal'], effective)).toStrictEqual([
      'vault:write',
      'vault:reveal',
    ]);
    expect(missingScopes(['vault:read'], effective)).toStrictEqual([]);
  });

  it('MCP-7 lists only the tools the effective scopes allow', () => {
    expect(toolsAllowedBy(['vault:generate'])).toStrictEqual([
      'generate_password',
      'generate_passphrase',
    ]);
    expect(toolsAllowedBy([])).toStrictEqual([]);
    expect(toolsAllowedBy([...SCOPES])).toStrictEqual([...TOOL_NAMES]);
  });
});
