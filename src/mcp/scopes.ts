/**
 * Scope registry (spec §03.8) and the tool → scope map (spec §06.2).
 *
 * No scope implies another (OAUTH-36); a tool needs exactly the scopes
 * listed here, and `create_item`/`update_item` with an explicit password
 * additionally need `vault:reveal` because the agent is handling secret
 * material.
 */
import type { Config } from '../config/index.ts';

export const SCOPES = ['vault:read', 'vault:reveal', 'vault:generate', 'vault:write'] as const;

export type Scope = (typeof SCOPES)[number];

export interface ScopeDefinition {
  readonly scope: Scope;
  /**
  One-line explanation shown on the consent page (OAUTH-36).
  */
  readonly description: string;
  /**
  Marked scopes get a prominent risk warning on the consent page (OAUTH-36).
  */
  readonly risk: boolean;
}

export const SCOPE_DEFINITIONS: readonly ScopeDefinition[] = [
  {
    scope: 'vault:read',
    description: 'Search and list items, folders and collections; item summaries without secrets.',
    risk: false,
  },
  {
    scope: 'vault:reveal',
    description: 'Reveal one secret field at a time: passwords, TOTP codes, notes, hidden fields.',
    risk: true,
  },
  {
    scope: 'vault:generate',
    description: 'Generate random passwords and passphrases; nothing is stored.',
    risk: false,
  },
  {
    scope: 'vault:write',
    description: 'Create, update and trash items; create folders.',
    risk: true,
  },
];

export const TOOL_NAMES = [
  'vault_status',
  'search_items',
  'get_item',
  'list_folders',
  'list_collections',
  'get_secret',
  'generate_password',
  'generate_passphrase',
  'create_item',
  'update_item',
  'trash_item',
  'create_folder',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_SCOPES: Readonly<Record<ToolName, Scope>> = {
  vault_status: 'vault:read',
  search_items: 'vault:read',
  get_item: 'vault:read',
  list_folders: 'vault:read',
  list_collections: 'vault:read',
  get_secret: 'vault:reveal',
  generate_password: 'vault:generate',
  generate_passphrase: 'vault:generate',
  create_item: 'vault:write',
  update_item: 'vault:write',
  trash_item: 'vault:write',
  create_folder: 'vault:write',
};

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/**
The scopes an operator has enabled: `vault:write` only by explicit opt-in (OAUTH-16).
*/
export function enabledScopes(config: Pick<Config, 'enableWriteScope'>): readonly Scope[] {
  return SCOPES.filter((scope) => scope !== 'vault:write' || config.enableWriteScope);
}

function hasExplicitPassword(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    'password' in input &&
    typeof input.password === 'string'
  );
}

/**
 * Every scope one tool call needs, so an insufficient-scope challenge can
 * list them all at once (OAUTH-33).
 */
export function requiredScopes(tool: ToolName, input: unknown): readonly Scope[] {
  const base = TOOL_SCOPES[tool];
  const requiresReveal =
    (tool === 'update_item' || tool === 'create_item') && hasExplicitPassword(input);
  return requiresReveal ? [base, 'vault:reveal'] : [base];
}

/**
 * A token grants a scope only when it holds it AND the operator has enabled it,
 * so flipping `VAULTGATE_ENABLE_WRITE_SCOPE` off revokes write access at once.
 */
export function effectiveScopes(
  held: readonly string[],
  enabled: readonly Scope[],
): readonly Scope[] {
  return enabled.filter((scope) => held.includes(scope));
}

export function missingScopes(
  required: readonly Scope[],
  effective: readonly Scope[],
): readonly Scope[] {
  return required.filter((scope) => !effective.includes(scope));
}

/**
The tools a token may see in `tools/list` (MCP-7).
*/
export function toolsAllowedBy(effective: readonly Scope[]): readonly ToolName[] {
  return TOOL_NAMES.filter((tool) => effective.includes(TOOL_SCOPES[tool]));
}
