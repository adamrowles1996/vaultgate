import { describe, expect, it } from 'vitest';

import { enabledScopes, SCOPES } from '../scopes/registry.ts';
import { ACTIONS_OFF, actionsEnabled } from '../test-support/actions-config.ts';

import {
  effectiveScopes,
  isRequirementMet,
  isToolName,
  listTargetsRequirement,
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
    const scopesOf = (tool: Parameters<typeof requiredScopes>[0], input: unknown): unknown =>
      requiredScopes(tool, input).scopes;
    expect(scopesOf('update_item', { item_id: 'x', password: 'pw' })).toStrictEqual([
      'vault:write',
      'vault:reveal',
    ]);
    expect(scopesOf('create_item', { name: 'x', password: 'pw' })).toStrictEqual([
      'vault:write',
      'vault:reveal',
    ]);
    expect(scopesOf('update_item', { item_id: 'x', generate_password: true })).toStrictEqual([
      'vault:write',
    ]);
    expect(scopesOf('update_item', { item_id: 'x', password: 42 })).toStrictEqual(['vault:write']);
    expect(scopesOf('update_item', null)).toStrictEqual(['vault:write']);
    expect(scopesOf('update_item', 'password')).toStrictEqual(['vault:write']);
    expect(requiredScopes('get_secret', { password: 'pw' })).toStrictEqual({
      scopes: ['vault:reveal'],
      mode: 'all',
    });
  });

  it('OAUTH-16 OAUTH-33 narrows held scopes to the enabled set and judges an all-of requirement against it', () => {
    const effective = effectiveScopes(
      ['vault:write', 'vault:read', 'offline_access'],
      enabledScopes({ enableWriteScope: false, actions: ACTIONS_OFF }),
    );
    expect(effective).toStrictEqual(['vault:read']);
    expect(
      isRequirementMet({ scopes: ['vault:write', 'vault:reveal'], mode: 'all' }, effective),
    ).toBe(false);
    expect(
      isRequirementMet({ scopes: ['vault:read', 'vault:reveal'], mode: 'all' }, effective),
    ).toBe(false);
    expect(isRequirementMet({ scopes: ['vault:read'], mode: 'all' }, effective)).toBe(true);
  });

  it('ACT-12 actions_list_targets needs any enabled actions scope, listed together in one challenge', () => {
    const enabled = enabledScopes({
      enableWriteScope: false,
      actions: actionsEnabled(['http', 'ssh']),
    });
    const requirement = listTargetsRequirement(enabled);
    expect(requirement).toStrictEqual({ scopes: ['actions:http', 'actions:ssh'], mode: 'any' });
    const anyOf = requirement ?? { scopes: [], mode: 'any' };
    expect(isRequirementMet(anyOf, ['vault:read', 'actions:ssh'])).toBe(true);
    expect(isRequirementMet(anyOf, ['vault:read', 'actions:sql.read'])).toBe(false);
    expect(isRequirementMet(anyOf, [])).toBe(false);
    const layerOff = enabledScopes({ enableWriteScope: true, actions: ACTIONS_OFF });
    const connectorsOff = enabledScopes({ enableWriteScope: false, actions: actionsEnabled([]) });
    expect(listTargetsRequirement(layerOff)).toBeUndefined();
    expect(listTargetsRequirement(connectorsOff)).toBeUndefined();
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
