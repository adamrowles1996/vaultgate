import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF, actionsEnabled } from '../test-support/actions-config.ts';

import {
  ACTION_SCOPE_CONNECTORS,
  enabledScopes,
  isActionScope,
  isScope,
  SCOPE_DEFINITIONS,
  scopeDefinition,
  SCOPES,
} from './registry.ts';

const VAULT_SCOPES = ['vault:read', 'vault:reveal', 'vault:generate', 'vault:write'] as const;
const ACTION_SCOPES = [
  'actions:http',
  'actions:sql.read',
  'actions:sql.write',
  'actions:ssh',
  'actions:winrm',
  'actions:browser',
  'actions:code',
] as const;

describe('scope registry', () => {
  it('OAUTH-1 OAUTH-2 ACT-12 lists the four vault scopes then the seven actions scopes in one order', () => {
    expect([...SCOPES]).toStrictEqual([...VAULT_SCOPES, ...ACTION_SCOPES]);
    expect(SCOPE_DEFINITIONS.map((definition) => definition.scope)).toStrictEqual([...SCOPES]);
  });

  it('OAUTH-4 never lists offline_access', () => {
    expect(isScope('offline_access')).toBe(false);
    expect(isScope('vault:read')).toBe(true);
  });

  it('OAUTH-36 marks vault:reveal and vault:write as risky with an explanation each', () => {
    expect(
      SCOPE_DEFINITIONS.filter(
        (definition) => definition.risky && !isActionScope(definition.scope),
      ).map((d) => d.scope),
    ).toStrictEqual(['vault:reveal', 'vault:write']);
    expect(SCOPE_DEFINITIONS.every((definition) => definition.explanation.length > 20)).toBe(true);
    expect(scopeDefinition('vault:generate').risky).toBe(false);
  });

  it('ACT-13 marks every actions scope risky and carries the §13.5 consent text verbatim', () => {
    expect(ACTION_SCOPES.every((scope) => scopeDefinition(scope).risky)).toBe(true);
    expect(ACTION_SCOPES.map((scope) => scopeDefinition(scope).explanation)).toStrictEqual([
      'Send HTTP requests to web APIs the operator has configured, signed with credentials from the vault.',
      'Run read-only queries against databases the operator has configured.',
      'Change data in databases the operator has configured.',
      'Run commands on servers the operator has configured, over SSH.',
      'Run commands on Windows hosts the operator has configured, over WinRM.',
      'Sign in to websites the operator has configured and act there as you, within the pages the operator allows.',
      'Search and read code in repositories the operator has configured.',
    ]);
  });

  it('ACT-12 maps each actions scope to exactly one connector and none to a vault scope', () => {
    expect(ACTION_SCOPE_CONNECTORS).toStrictEqual({
      'actions:http': 'http',
      'actions:sql.read': 'sql',
      'actions:sql.write': 'sql',
      'actions:ssh': 'ssh',
      'actions:winrm': 'winrm',
      'actions:browser': 'browser',
      'actions:code': 'code',
    });
    expect(VAULT_SCOPES.some((scope) => isActionScope(scope))).toBe(false);
  });

  it('throws for a scope outside the registry', () => {
    expect(() => scopeDefinition('vault:admin' as never)).toThrow('not in the registry');
  });

  it('OAUTH-16 enables vault:write only when the operator opts in', () => {
    expect(enabledScopes({ enableWriteScope: false, actions: ACTIONS_OFF })).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
    expect(enabledScopes({ enableWriteScope: true, actions: ACTIONS_OFF })).toStrictEqual([
      ...VAULT_SCOPES,
    ]);
  });

  it('ACT-14 enables an actions scope only when the layer and that connector are both on', () => {
    const connectorOnly = { ...ACTIONS_OFF, connectors: { ...ACTIONS_OFF.connectors, http: true } };
    expect(enabledScopes({ enableWriteScope: true, actions: connectorOnly })).toStrictEqual([
      ...VAULT_SCOPES,
    ]);
    expect(
      enabledScopes({ enableWriteScope: true, actions: actionsEnabled(['http', 'browser']) }),
    ).toStrictEqual([...VAULT_SCOPES, 'actions:http', 'actions:browser']);
    expect(enabledScopes({ enableWriteScope: false, actions: actionsEnabled([]) })).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
  });
});
