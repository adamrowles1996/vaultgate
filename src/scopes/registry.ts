/**
 * The scope registry (spec §03.8, §06.2), held once for both the
 * authorization server and the MCP resource server: the names in the order
 * both metadata documents advertise them (OAUTH-1, OAUTH-2), the one-line
 * explanation and the risk marker the consent page shows (OAUTH-36). No scope
 * implies another.
 */
export const SCOPES = ['vault:read', 'vault:reveal', 'vault:generate', 'vault:write'] as const;

export type Scope = (typeof SCOPES)[number];

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
    scope: 'vault:generate',
    explanation: 'Generate passwords and passphrases.',
    risky: false,
  },
  {
    scope: 'vault:write',
    explanation: 'Create, update and trash items and folders.',
    risky: true,
  },
];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

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
 * The scopes an operator has enabled: `vault:write` only by explicit opt-in
 * (OAUTH-16). A token grants a scope only while it stays enabled, so turning
 * `VAULTGATE_ENABLE_WRITE_SCOPE` off revokes write access at once.
 */
export function enabledScopes(config: { readonly enableWriteScope: boolean }): readonly Scope[] {
  return SCOPES.filter((scope) => scope !== 'vault:write' || config.enableWriteScope);
}
