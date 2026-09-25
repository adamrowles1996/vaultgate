/**
 * What a connector declares about its tools and targets for the MCP layer
 * and `actions_list_targets` (spec §13.6, ACT-15, ACT-19): the operation
 * schema, the tool itself, its `repo` form (ACT-110) and what a listing may
 * say about a target. Re-exported by `./connector.ts`.
 */
import type { OutputSchema, ToolAnnotations } from '../../mcp/tools/definition.ts';
import type { ActionScope } from '../../scopes/registry.ts';
import type { OperationKind } from '../policy.ts';
import type { z } from 'zod';

/**
 * The operation half of a tool's arguments: a strict object, so the MCP layer
 * can put `target` in front of its shape when it advertises the tool (ACT-16)
 * and the engine can parse the arguments minus `target` with it.
 */
export type OperationSchema<Operation> = z.ZodObject<z.ZodRawShape, z.core.$strict> &
  z.ZodType<Operation>;

/**
 * ACT-110: a tool that names its target in `repo` rather than `target`, and
 * may name up to `max` of them at once; the engine resolves each in the
 * ACT-16 order and records a row for each. `singleOnly` lists the arguments
 * that may be given with one target only. Only a read-only tool may take more
 * than one target, so no confirmation is ever needed for such a call.
 */
export interface RepoArgument {
  readonly max: number;
  readonly description: string;
  readonly singleOnly: readonly string[];
}

/**
 * One MCP tool a connector serves (spec §13.6): the name and scope the gate
 * checks, the LLM-facing description of ACT-17, the annotations of the
 * 13.6.1 table (ACT-18), the operation arguments and the strict result shape
 * (ACT-15). `src/mcp/tools/actions.ts` registers every tool of every loaded
 * connector and dispatches its calls to the engine; a connector adds a tool
 * by declaring one of these.
 */
export interface ConnectorTool<Operation> {
  readonly name: string;
  readonly scope: ActionScope;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  /**
  The tool's arguments minus `target` (and `session_id`), strict.
  */
  readonly inputSchema: OperationSchema<Operation>;
  /**
  What the engine returns for the tool, strict; never a place for a credential.
  */
  readonly outputSchema: OutputSchema;
  /**
  Present when the tool names its targets in `repo` (the `code` tools) instead of `target`.
  */
  readonly repo?: RepoArgument;
}

interface OperationGrant {
  readonly operation: OperationKind;
  readonly scope: ActionScope;
}

/**
What `actions_list_targets` may say about a target (ACT-19), before the scope filter.
*/
export interface TargetCapabilities {
  readonly operations: readonly OperationGrant[];
  readonly engine?: 'mssql' | 'postgres';
  readonly unrestricted?: boolean;
  /**
  ACT-112: what an agent needs to know about a `code` target; never the token field.
  */
  readonly code?: {
    readonly repository: string;
    readonly ref: string | undefined;
    readonly content: readonly string[];
    readonly read: boolean;
  };
}
