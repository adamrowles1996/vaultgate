import { describe, expect, it } from 'vitest';

import { enabledScopes, SCOPES } from '../scopes/registry.ts';
import { ACTIONS_OFF } from '../test-support/actions-config.ts';

import {
  effectiveScopes,
  isToolName,
  missingScopes,
  requiredScopes,
  TOOL_NAMES,
  TOOL_SCOPES,
  toolsAllowedBy,
} from './scopes.ts';

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('scopes', () => {
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
      enabledScopes({ enableWriteScope: false, actions: ACTIONS_OFF }),
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
