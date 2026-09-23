import { describe, expect, it } from 'vitest';

import { enabledScopes } from '../scopes/registry.ts';
import { ACTIONS_OFF } from '../test-support/actions-config.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { DEFAULT_SCOPES, isScopeSubset, parseScopeParameter } from './scopes.ts';

describe('parseScopeParameter', () => {
  const enabled = enabledScopes({ enableWriteScope: false, actions: ACTIONS_OFF });

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
