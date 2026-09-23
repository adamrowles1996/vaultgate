import { describe, expect, it } from 'vitest';

import { enabledScopes, isScope, SCOPE_DEFINITIONS, scopeDefinition, SCOPES } from './registry.ts';

describe('scope registry', () => {
  it('OAUTH-1 OAUTH-2 lists the four scopes in the one order both metadata documents advertise', () => {
    expect([...SCOPES]).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
      'vault:write',
    ]);
    expect(SCOPE_DEFINITIONS.map((definition) => definition.scope)).toStrictEqual([...SCOPES]);
  });

  it('OAUTH-4 never lists offline_access', () => {
    expect(isScope('offline_access')).toBe(false);
    expect(isScope('vault:read')).toBe(true);
  });

  it('OAUTH-36 marks vault:reveal and vault:write as risky with an explanation each', () => {
    expect(
      SCOPE_DEFINITIONS.filter((definition) => definition.risky).map((d) => d.scope),
    ).toStrictEqual(['vault:reveal', 'vault:write']);
    expect(SCOPE_DEFINITIONS.every((definition) => definition.explanation.length > 20)).toBe(true);
    expect(scopeDefinition('vault:generate').risky).toBe(false);
  });

  it('throws for a scope outside the registry', () => {
    expect(() => scopeDefinition('vault:admin' as never)).toThrow('not in the registry');
  });

  it('OAUTH-16 enables vault:write only when the operator opts in', () => {
    expect(enabledScopes({ enableWriteScope: false })).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
    expect(enabledScopes({ enableWriteScope: true })).toStrictEqual([...SCOPES]);
  });
});
