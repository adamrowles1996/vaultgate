/**
 * The authorization server's view of the registry in `src/scopes/registry.ts`:
 * parsing the RFC 6749 §3.3 `scope` parameter and comparing grants.
 */
import { fail, ok, type Result } from '../result.ts';
import { isScope, type Scope } from '../scopes/registry.ts';

export const DEFAULT_SCOPES: readonly Scope[] = ['vault:read'];

export class ScopeError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(`scope "${scope}" is not available`);
    this.name = 'ScopeError';
    this.scope = scope;
  }
}

/**
 * Parses an RFC 6749 §3.3 space-delimited `scope` value. An absent or empty
 * value means `vault:read` (OAUTH-16). Order is preserved, duplicates dropped.
 */
export function parseScopeParameter(
  text: string | undefined,
  enabled: readonly Scope[],
): Result<readonly Scope[], ScopeError> {
  const requested = (text ?? '').split(' ').filter((entry) => entry.length > 0);
  if (requested.length === 0) {
    return ok(DEFAULT_SCOPES);
  }
  const scopes: Scope[] = [];
  for (const entry of requested) {
    if (!isScope(entry) || !enabled.includes(entry)) {
      return fail(new ScopeError(entry));
    }
    if (!scopes.includes(entry)) {
      scopes.push(entry);
    }
  }
  return ok(scopes);
}

export function isScopeSubset(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((scope) => granted.includes(scope));
}
