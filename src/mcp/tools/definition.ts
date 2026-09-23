/**
 * The shape every tool shares. A tool is data plus one `run` function over the
 * `VaultClient` interface (ARCH-6); the server factory turns it into an SDK
 * registration and wraps it with scope filtering and auditing.
 */

import type { Result } from '../../result.ts';
import type { VaultClient, VaultError } from '../../vault/client.ts';
import type { ToolName } from '../scopes.ts';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/**
The MCP `ToolAnnotations` fields, exactly (ACT-18); the vault tools are closed-world, the actions tools reach out.
*/
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
A failure raised by the tool itself rather than by the vault (bad field name, conflicting options).
*/
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export type ToolFailure = VaultError | ToolError;

/**
What the audit trail may know about a call (MCP-13): an item id and, for `get_secret`, a field name.
*/
interface AuditReference {
  readonly itemId?: string;
  readonly field?: string;
}

/**
Every tool result is an object, which is what the SDK's `structuredContent` requires.
*/
export type OutputSchema = z.ZodType<Record<string, unknown>>;

export type ToolRun<Input extends z.ZodType, Output extends OutputSchema> = (
  vault: VaultClient,
  input: z.output<Input>,
) => Promise<Result<z.output<Output>, ToolFailure>>;

export interface ToolDefinition<Input extends z.ZodType, Output extends OutputSchema> {
  readonly name: ToolName;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly auditReference?: (input: z.output<Input>) => AuditReference;
  readonly run: ToolRun<Input, Output>;
}

/**
The type-erased form the registry holds; the SDK validates input against `inputSchema` before `run`.
*/
export interface Tool {
  readonly name: ToolName;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: OutputSchema;
  readonly auditReference: (input: unknown) => AuditReference;
  readonly run: (
    vault: VaultClient,
    input: unknown,
  ) => Promise<Result<Record<string, unknown>, ToolFailure>>;
}

export function defineTool<Input extends z.ZodType, Output extends OutputSchema>(
  definition: ToolDefinition<Input, Output>,
): Tool {
  const { auditReference, run, ...rest } = definition;
  return {
    ...rest,
    auditReference: (input) => auditReference?.(input as z.output<Input>) ?? {},
    run: (vault, input) => run(vault, input as z.output<Input>),
  };
}

/**
 * ACT-15, MCP-6: every failure is `{ error, message, detail? }` with
 * `isError`, the same JSON as text; `detail` is the only variable part and
 * the vault tools have none (ACT-74).
 */
export function failureResult(
  code: string,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): CallToolResult {
  const body = { error: code, message, ...(detail !== undefined && { detail }) };
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: body,
    isError: true,
  };
}

export const READ_ONLY: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
