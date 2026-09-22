import { fail, ok, type Result } from '../result.ts';

export type Scope = 'vault:read' | 'vault:reveal' | 'vault:write' | 'vault:generate';

export interface ScopeDefinition {
  readonly scope: Scope;
  /**
  One-line explanation shown on the consent page (OAUTH-36).
  */
  readonly explanation: string;
  /**
  Marked prominently on the consent page (OAUTH-36).
  */
  readonly risky: boolean;
}

/**
 * The registry, in the order the metadata documents list it (OAUTH-1).
 * No scope implies another (OAUTH-36).
 */
export const SCOPE_DEFINITIONS: readonly ScopeDefinition[] = [
  {
    scope: 'vault:read',
    explanation:
      'Search and list items, folders and collections; see item details without secrets.',
    risky: false,
  },
  {
    scope: 'vault:reveal',
    explanation: 'Reveal passwords, TOTP codes, secure notes and hidden fields.',
    risky: true,
  },
  {
    scope: 'vault:write',
    explanation: 'Create, update and trash items and folders.',
    risky: true,
  },
  {
    scope: 'vault:generate',
    explanation: 'Generate passwords and passphrases.',
    risky: false,
  },
];

export const SCOPES_SUPPORTED: readonly Scope[] = SCOPE_DEFINITIONS.map(({ scope }) => scope);

export const DEFAULT_SCOPES: readonly Scope[] = ['vault:read'];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES_SUPPORTED);

export function isScope(text: string): text is Scope {
  return SCOPE_SET.has(text);
}

export function scopeDefinition(scope: Scope): ScopeDefinition {
  const definition = SCOPE_DEFINITIONS.find((candidate) => candidate.scope === scope);
  if (definition === undefined) {
    throw new Error(`scope "${scope}" is not in the registry`);
  }
  return definition;
}

/**
 * OAUTH-16: `vault:write` is only requestable when the operator enabled it.
 */
export function enabledScopes(config: { readonly enableWriteScope: boolean }): readonly Scope[] {
  return SCOPES_SUPPORTED.filter((scope) => scope !== 'vault:write' || config.enableWriteScope);
}

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

export function formatScopes(scopes: readonly Scope[]): string {
  return scopes.join(' ');
}
