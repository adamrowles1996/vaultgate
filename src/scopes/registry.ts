/**
 * The scope registry (spec §03.8, §06.2, §13.5), held once for both the
 * authorization server and the MCP resource server: the names in the order
 * both metadata documents advertise them (OAUTH-1, OAUTH-2), the one-line
 * explanation and the risk marker the consent page shows (OAUTH-36, ACT-13).
 * No scope implies another (ACT-12).
 */
import type { ActionsConfig, ConnectorKind } from '../config/actions.ts';

export const SCOPES = [
  'vault:read',
  'vault:reveal',
  'vault:generate',
  'vault:write',
  'actions:http',
  'actions:sql.read',
  'actions:sql.write',
  'actions:ssh',
  'actions:winrm',
  'actions:browser',
] as const;

export type Scope = (typeof SCOPES)[number];

export type ActionScope = Extract<Scope, `actions:${string}`>;

/**
The connector each `actions:*` scope reaches (§13.5); its switch gates the scope (ACT-14).
*/
export const ACTION_SCOPE_CONNECTORS: Readonly<Record<ActionScope, ConnectorKind>> = {
  'actions:http': 'http',
  'actions:sql.read': 'sql',
  'actions:sql.write': 'sql',
  'actions:ssh': 'ssh',
  'actions:winrm': 'winrm',
  'actions:browser': 'browser',
};

export interface ScopeDefinition {
  readonly scope: Scope;
  /**
  One-line explanation shown on the consent page (OAUTH-36); the §13.5 consent text for actions.
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
  {
    scope: 'actions:http',
    explanation:
      'Send HTTP requests to web APIs the operator has configured, signed with credentials from the vault.',
    risky: true,
  },
  {
    scope: 'actions:sql.read',
    explanation: 'Run read-only queries against databases the operator has configured.',
    risky: true,
  },
  {
    scope: 'actions:sql.write',
    explanation: 'Change data in databases the operator has configured.',
    risky: true,
  },
  {
    scope: 'actions:ssh',
    explanation: 'Run commands on servers the operator has configured, over SSH.',
    risky: true,
  },
  {
    scope: 'actions:winrm',
    explanation: 'Run commands on Windows hosts the operator has configured, over WinRM.',
    risky: true,
  },
  {
    scope: 'actions:browser',
    explanation:
      'Sign in to websites the operator has configured and act there as you, within the pages the operator allows.',
    risky: true,
  },
];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(text: string): text is Scope {
  return SCOPE_SET.has(text);
}

export function isActionScope(scope: Scope): scope is ActionScope {
  return Object.hasOwn(ACTION_SCOPE_CONNECTORS, scope);
}

export function scopeDefinition(scope: Scope): ScopeDefinition {
  const definition = SCOPE_DEFINITIONS.find((candidate) => candidate.scope === scope);
  if (definition === undefined) {
    throw new Error(`scope "${scope}" is not in the registry`);
  }
  return definition;
}

/**
The configuration a scope's availability depends on.
*/
export interface ScopeSwitches {
  readonly enableWriteScope: boolean;
  readonly actions: Pick<ActionsConfig, 'enabled' | 'connectors'>;
}

function isEnabled(scope: Scope, config: ScopeSwitches): boolean {
  return isActionScope(scope)
    ? config.actions.enabled && config.actions.connectors[ACTION_SCOPE_CONNECTORS[scope]]
    : scope !== 'vault:write' || config.enableWriteScope;
}

/**
 * The scopes an operator has enabled: `vault:write` only by explicit opt-in
 * (OAUTH-16), an `actions:*` scope only when the layer and its connector are
 * both on (ACT-14). A token grants a scope only while it stays enabled, so
 * turning a switch off revokes the access at once.
 */
export function enabledScopes(config: ScopeSwitches): readonly Scope[] {
  return SCOPES.filter((scope) => isEnabled(scope, config));
}
