/**
 * The tool → scope map (spec §06.2) over the registry in
 * `src/scopes/registry.ts`.
 *
 * No scope implies another (OAUTH-36); a tool needs exactly the scopes
 * listed here, and `create_item`/`update_item` with an explicit password
 * additionally need `vault:reveal` because the agent is handling secret
 * material.
 */
import type { Scope } from '../scopes/registry.ts';

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
