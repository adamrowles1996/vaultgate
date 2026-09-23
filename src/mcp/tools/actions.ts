/**
 * The actions tools (spec §13.6): `actions_list_targets` (ACT-19) and every
 * tool the loaded connectors declare, registered only for the scopes the
 * token holds (MCP-7, ACT-14) and only when an engine exists (ACT-73). A
 * connector tool is added by declaring a `ConnectorTool` on its connector;
 * the registration here puts `target` in front of its arguments (ACT-16)
 * and dispatches the call to the engine, which records the MCP-13 event
 * itself (ACT-60), so nothing here audits a connector call twice.
 */
import { z } from 'zod';

import { targetNameSchema } from '../../actions/targets-schemas.ts';
import { CONNECTOR_KINDS } from '../../config/actions.ts';
import { isActionScope } from '../../scopes/registry.ts';
import { LIST_TARGETS_TOOL } from '../scopes.ts';

import { type ActionsCallContext, callerFor, toActionResult } from './actions-call.ts';
import { READ_ONLY, type ToolAnnotations } from './definition.ts';

import type { ConnectorTool } from '../../actions/connectors/connector.ts';
import type { ActionsEngine } from '../../actions/engine.ts';
import type { OperationKind } from '../../actions/policy.ts';
import type { AuditSink } from '../../audit/event.ts';
import type { McpServer } from '@modelcontextprotocol/server';

export interface ActionsToolDependencies {
  readonly engine: ActionsEngine;
  readonly audit: AuditSink;
  readonly now: () => number;
}

const OPERATION_KINDS = [
  'read',
  'write',
  'shell',
  'act',
] as const satisfies readonly OperationKind[];

const operationsSchema = z
  .array(z.enum(OPERATION_KINDS))
  .describe('What the policy allows and your scopes can reach.');
const unrestrictedSchema = z.literal(true).describe('The target accepts any command.');

/**
ACT-19: no place for a destination, an origin, a credential field name or a policy pattern.
*/
const targetListingSchema = z.strictObject({
  name: z.string().describe('Pass this as `target` to the other actions tools.'),
  description: z
    .string()
    .describe('Operator prose: what the destination is and what to use it for.'),
  connector: z.enum(CONNECTOR_KINDS),
  operations: operationsSchema,
  confirm_writes: z
    .boolean()
    .describe('True when every non-read call asks a human for confirmation first.'),
  engine: z.enum(['mssql', 'postgres']).optional(),
  unrestricted: unrestrictedSchema.optional(),
});

export const listTargetsOutput = z.strictObject({ targets: z.array(targetListingSchema) });

export const LIST_TARGETS_ANNOTATIONS: ToolAnnotations = {
  ...READ_ONLY,
  title: 'List action targets',
};

export const LIST_TARGETS_DESCRIPTION =
  'Lists the action targets this client may use. Each entry gives the target name (the `target` ' +
  'argument of every other actions tool), an operator-written description of what the ' +
  'destination is and what to use it for, its connector, the operations the target policy and ' +
  'your scopes allow (read, write, shell, act), whether non-read calls will ask a human for ' +
  'confirmation (confirm_writes), the database engine of a sql target and whether a shell ' +
  'target accepts any command (unrestricted). Returns no destination address, no credential ' +
  'and no policy pattern; never a secret. Call it before any other actions tool and pass a ' +
  'name it returned as target.';

const TARGET_ARGUMENT = targetNameSchema.describe(
  'The target name, exactly as actions_list_targets returned it.',
);

function registerListTargets(
  server: McpServer,
  dependencies: ActionsToolDependencies,
  context: ActionsCallContext,
): void {
  server.registerTool(
    LIST_TARGETS_TOOL,
    {
      title: LIST_TARGETS_ANNOTATIONS.title,
      description: LIST_TARGETS_DESCRIPTION,
      inputSchema: z.strictObject({}),
      outputSchema: listTargetsOutput,
      annotations: LIST_TARGETS_ANNOTATIONS,
    },
    () => {
      const startedAt = dependencies.now();
      const targets = dependencies.engine.listTargets({
        clientId: context.token.clientId,
        scopes: context.scopes,
      });
      const result = { targets };
      dependencies.audit.record({
        category: 'mcp',
        action: LIST_TARGETS_TOOL,
        outcome: 'ok',
        operatorId: context.token.subject,
        clientId: context.token.clientId,
        tokenPrefix: context.token.tokenId,
        requestId: context.requestId,
        ip: context.sourceIp,
        durationMs: dependencies.now() - startedAt,
        details: { clientName: context.token.clientName },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}

function registerConnectorTool(
  server: McpServer,
  tool: ConnectorTool<unknown>,
  dependencies: ActionsToolDependencies,
  context: ActionsCallContext,
): void {
  const inputSchema = z.strictObject({ target: TARGET_ARGUMENT, ...tool.inputSchema.shape });
  server.registerTool(
    tool.name,
    {
      title: tool.annotations.title,
      description: tool.description,
      inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    async (input, serverContext) => {
      const outcome = await dependencies.engine.call(callerFor(context, serverContext), {
        tool: tool.name,
        target: input.target,
        arguments: input,
      });
      return toActionResult(outcome);
    },
  );
}

/**
MCP-7, ACT-14: a tool is registered only when the token's effective scopes reach it.
*/
export function registerActionsTools(
  server: McpServer,
  dependencies: ActionsToolDependencies,
  context: ActionsCallContext,
): void {
  if (context.scopes.some((scope) => isActionScope(scope))) {
    registerListTargets(server, dependencies, context);
  }
  for (const tool of dependencies.engine.tools) {
    if (context.scopes.includes(tool.scope)) {
      registerConnectorTool(server, tool, dependencies, context);
    }
  }
}
