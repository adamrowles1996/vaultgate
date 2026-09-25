/**
 * Builds the per-request `McpServer` (MCP-1): only the tools the token's
 * effective scopes allow are registered (MCP-7), every call is audited
 * (MCP-13), no resources or prompts exist (MCP-8), and the actions tools of
 * section 13 exist only while an engine does (ACT-73). A token that can use
 * them is told to prefer them over `get_secret` (MCP-16).
 */
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { isActionScope, type Scope } from '../scopes/registry.ts';
import { VERSION } from '../version.ts';

import { toolsAllowedBy } from './scopes.ts';
import { registerActionsTools } from './tools/actions.ts';
import { failureResult, type Tool, type ToolFailure } from './tools/definition.ts';
import { ALL_TOOLS } from './tools/index.ts';

import type { Caller } from '../actions/caller.ts';
import type { ActionsEngine } from '../actions/engine.ts';
import type { AuditEvent, AuditSink } from '../audit/event.ts';
import type { VerifiedToken } from '../auth/token-types.ts';
import type { Result } from '../result.ts';
import type { VaultClient } from '../vault/client.ts';

const VAULT_INSTRUCTIONS =
  'vaultgate exposes one Bitwarden vault. Read tools return metadata only; get_secret is the ' +
  'sole way to read a secret value and every call is audited. Search first, then act on ids.';

/**
MCP-16: a token that can use actions is steered to them, so a credential it needs to use never
enters the conversation.
*/
const ACTIONS_INSTRUCTIONS =
  'vaultgate lets you use the credentials in one Bitwarden vault without seeing them. To act on ' +
  'a system, call actions_list_targets, then the action tool for that target: vaultgate injects ' +
  "the credential, runs the operation under the operator's policy and returns a scrubbed " +
  'result. Prefer an action to get_secret, so that no secret enters the conversation; ' +
  'get_secret is the sole way to read a secret value and every call is audited. Vault read ' +
  'tools return metadata only; search first, then act on ids.';

/**
 * MCP-16, spec 14.8.6: `semble`'s own guidance for the code tools, given to a
 * token that holds `actions:code`, as `semble`'s MCP server gives it.
 */
const CODE_INSTRUCTIONS =
  ' Code search: call code_search once with a focused query and a repo from ' +
  'actions_list_targets (connector code); it returns the file path and exact line. Go straight ' +
  'to that file and line (code_read, or your own checkout) and do not search again for the same ' +
  'thing. Use code_find_related to discover similar code elsewhere in the same repos. When a ' +
  'snippet does not show enough, call again with max_snippet_lines: null. Pass a list of repos ' +
  'to search several at once; results then prefix file_path with the repo name.';

export interface CallContext {
  readonly token: VerifiedToken;
  /**
  Scopes the token holds AND the operator has enabled.
  */
  readonly scopes: readonly Scope[];
  readonly requestId: string;
  readonly sourceIp: string;
  /**
  ACT-48: whether the request declared form-mode elicitation.
  */
  readonly elicitation: Caller['elicitation'];
}

export interface ServerDependencies {
  readonly vault: VaultClient;
  readonly audit: AuditSink;
  readonly now: () => number;
  /**
  Present only when the actions layer is enabled (ACT-73).
  */
  readonly engine?: ActionsEngine | undefined;
}

function toCallToolResult(result: Result<Record<string, unknown>, ToolFailure>): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value) }],
      structuredContent: result.value,
    };
  }
  return failureResult(result.error.code, result.error.message);
}

function registerVaultTool(
  server: McpServer,
  tool: Tool,
  dependencies: ServerDependencies,
  context: CallContext,
): void {
  server.registerTool(
    tool.name,
    {
      title: tool.annotations.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    async (input) => {
      const startedAt = dependencies.now();
      const result = await tool.run(dependencies.vault, input);
      const reference = tool.auditReference(input);
      const event: AuditEvent = {
        category: 'mcp',
        action: tool.name,
        outcome: result.ok ? 'ok' : `error:${result.error.code}`,
        operatorId: context.token.subject,
        clientId: context.token.clientId,
        tokenPrefix: context.token.tokenId,
        itemId: reference.itemId,
        field: reference.field,
        requestId: context.requestId,
        ip: context.sourceIp,
        durationMs: dependencies.now() - startedAt,
        details: { clientName: context.token.clientName },
      };
      dependencies.audit.record(event);
      return toCallToolResult(result);
    },
  );
}

function instructionsFor(dependencies: ServerDependencies, context: CallContext): string {
  if (dependencies.engine === undefined || context.scopes.every((scope) => !isActionScope(scope))) {
    return VAULT_INSTRUCTIONS;
  }
  const hasCode =
    context.scopes.includes('actions:code') && dependencies.engine.connectors.includes('code');
  return hasCode ? ACTIONS_INSTRUCTIONS + CODE_INSTRUCTIONS : ACTIONS_INSTRUCTIONS;
}

export function createVaultMcpServer(
  dependencies: ServerDependencies,
  context: CallContext,
): McpServer {
  const server = new McpServer(
    { name: 'vaultgate', version: VERSION },
    { capabilities: { tools: {} }, instructions: instructionsFor(dependencies, context) },
  );
  const allowed = toolsAllowedBy(context.scopes);
  for (const tool of ALL_TOOLS) {
    if (allowed.includes(tool.name)) {
      registerVaultTool(server, tool, dependencies, context);
    }
  }
  if (dependencies.engine !== undefined) {
    const { engine, audit, now } = dependencies;
    registerActionsTools(server, { engine, audit, now }, context);
  }
  return server;
}
