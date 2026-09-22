import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  DEFAULT_SCOPES,
  enabledScopes,
  formatScopes,
  isScope,
  isScopeSubset,
  parseScopeParameter,
  SCOPE_DEFINITIONS,
  scopeDefinition,
  SCOPES_SUPPORTED,
} from './scopes.ts';

describe('scope registry', () => {
  it('OAUTH-1 lists the four scopes in the documented order', () => {
    expect(SCOPES_SUPPORTED).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:write',
      'vault:generate',
    ]);
  });

  it('OAUTH-4 never lists offline_access', () => {
    expect(isScope('offline_access')).toBe(false);
  });

  it('OAUTH-36 marks vault:reveal and vault:write as risky with an explanation each', () => {
    expect(
      SCOPE_DEFINITIONS.filter((definition) => definition.risky).map((d) => d.scope),
    ).toStrictEqual(['vault:reveal', 'vault:write']);
    expect(SCOPE_DEFINITIONS.every((definition) => definition.explanation.length > 0)).toBe(true);
    expect(scopeDefinition('vault:generate').risky).toBe(false);
  });

  it('throws for a scope outside the registry', () => {
    expect(() => scopeDefinition('vault:admin' as never)).toThrow('not in the registry');
  });
});

describe('enabledScopes', () => {
  it('OAUTH-16 excludes vault:write unless the operator enabled it', () => {
    expect(enabledScopes({ enableWriteScope: false })).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
    expect(enabledScopes({ enableWriteScope: true })).toStrictEqual(SCOPES_SUPPORTED);
  });
});

describe('parseScopeParameter', () => {
  const enabled = enabledScopes({ enableWriteScope: false });

  it('OAUTH-16 defaults an empty scope to vault:read', () => {
    expect(unwrapOk(parseScopeParameter(undefined, enabled))).toStrictEqual(DEFAULT_SCOPES);
    expect(unwrapOk(parseScopeParameter('  ', enabled))).toStrictEqual(['vault:read']);
  });

  it('OAUTH-16 keeps order and drops duplicates', () => {
    expect(
      unwrapOk(parseScopeParameter('vault:reveal vault:read vault:reveal', enabled)),
    ).toStrictEqual(['vault:reveal', 'vault:read']);
  });

  it('OAUTH-16 rejects an unknown scope', () => {
    expect(unwrapFail(parseScopeParameter('vault:read vault:admin', enabled)).scope).toBe(
      'vault:admin',
    );
  });

  it('OAUTH-16 rejects vault:write when it is disabled', () => {
    expect(unwrapFail(parseScopeParameter('vault:write', enabled)).message).toBe(
      'scope "vault:write" is not available',
    );
  });
});

describe('isScopeSubset', () => {
  it('OAUTH-36 implies nothing: each scope must be granted explicitly', () => {
    expect(isScopeSubset(['vault:read'], ['vault:read', 'vault:reveal'])).toBe(true);
    expect(isScopeSubset(['vault:reveal'], ['vault:read'])).toBe(false);
    expect(isScopeSubset([], ['vault:read'])).toBe(true);
  });
});

describe('formatScopes', () => {
  it('joins with single spaces (RFC 6749 §3.3)', () => {
    expect(formatScopes(['vault:read', 'vault:generate'])).toBe('vault:read vault:generate');
  });
});
