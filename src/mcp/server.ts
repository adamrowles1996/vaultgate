/**
 * Builds the per-request `McpServer` (MCP-1): only the tools the token's
 * effective scopes allow are registered (MCP-7), every call is audited
 * (MCP-13), and no resources or prompts exist (MCP-8).
 */
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { type Scope, toolsAllowedBy } from './scopes.ts';
import { ALL_TOOLS } from './tools/index.ts';

import type { Result } from '../result.ts';
import type { AuditEvent, AuditSink } from './audit.ts';
import type { VerifiedToken } from './token-verifier.ts';
import type { VaultClient } from '../vault/client.ts';
import type { Tool, ToolFailure } from './tools/definition.ts';

/**
Reported to clients in `initialize`; bumped with the package.
*/
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS =
  'vaultgate exposes one Bitwarden vault. Read tools return metadata only; get_secret is the ' +
  'sole way to read a secret value and every call is audited. Search first, then act on ids.';

export interface CallContext {
  readonly token: VerifiedToken;
  /**
  Scopes the token holds AND the operator has enabled.
  */
  readonly scopes: readonly Scope[];
  readonly requestId: string;
  readonly sourceIp: string;
}

export interface ServerDependencies {
  readonly vault: VaultClient;
  readonly audit: AuditSink;
  readonly now: () => number;
}

function toCallToolResult(result: Result<Record<string, unknown>, ToolFailure>): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value) }],
      structuredContent: result.value,
    };
  }
  const { code, message } = result.error;
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: code, message },
    isError: true,
  };
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
        timestamp: new Date(dependencies.now()).toISOString(),
        clientId: context.token.clientId,
        clientName: context.token.clientName,
        subject: context.token.subject,
        tokenId: context.token.tokenId,
        tool: tool.name,
        outcome: result.ok ? 'ok' : `error:${result.error.code}`,
        itemId: reference.itemId ?? null,
        field: reference.field ?? null,
        durationMs: dependencies.now() - startedAt,
        requestId: context.requestId,
        sourceIp: context.sourceIp,
      };
      dependencies.audit.record(event);
      return toCallToolResult(result);
    },
  );
}

export function createVaultMcpServer(
  dependencies: ServerDependencies,
  context: CallContext,
): McpServer {
  const server = new McpServer(
    { name: 'vaultgate', version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const allowed = toolsAllowedBy(context.scopes);
  for (const tool of ALL_TOOLS) {
    if (allowed.includes(tool.name)) {
      registerVaultTool(server, tool, dependencies, context);
    }
  }
  return server;
}
