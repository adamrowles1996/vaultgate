import { unwrapFail, unwrapOk } from './result.ts';

import type { Tool, ToolFailure } from '../mcp/tools/definition.ts';
import type { Result } from '../result.ts';
import type { VaultClient } from '../vault/client.ts';

/**
Validates raw arguments exactly as the SDK would (defaults applied), then runs the tool.
*/
function runTool(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
): Promise<Result<Record<string, unknown>, ToolFailure>> {
  return tool.run(vault, tool.inputSchema.parse(input));
}

export async function runOk(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
): Promise<Record<string, unknown>> {
  return unwrapOk(await runTool(tool, vault, input));
}

export async function runFail(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
): Promise<ToolFailure> {
  return unwrapFail(await runTool(tool, vault, input));
}

export async function failureCode(tool: Tool, vault: VaultClient, input: unknown): Promise<string> {
  const failure = await runFail(tool, vault, input);
  return failure.code;
}
