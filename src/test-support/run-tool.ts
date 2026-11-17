import { unwrapFail, unwrapOk } from './result.ts';

import type { Tool, ToolFailure, ToolSettings } from '../mcp/tools/definition.ts';
import type { Result } from '../result.ts';
import type { VaultClient } from '../vault/client.ts';

const NO_TOOL_SETTINGS: ToolSettings = { writeOrganizations: [] };

/**
 * Validates raw arguments exactly as the SDK would (defaults applied), then
 * runs the tool; no organisation is writable unless `settings` says so.
 */
function runTool(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
  settings: ToolSettings,
): Promise<Result<Record<string, unknown>, ToolFailure>> {
  return tool.run(vault, tool.inputSchema.parse(input), settings);
}

export async function runOk(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
  settings: ToolSettings = NO_TOOL_SETTINGS,
): Promise<Record<string, unknown>> {
  return unwrapOk(await runTool(tool, vault, input, settings));
}

export async function runFail(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
  settings: ToolSettings = NO_TOOL_SETTINGS,
): Promise<ToolFailure> {
  return unwrapFail(await runTool(tool, vault, input, settings));
}

export async function failureCode(
  tool: Tool,
  vault: VaultClient,
  input: unknown,
  settings: ToolSettings = NO_TOOL_SETTINGS,
): Promise<string> {
  const failure = await runFail(tool, vault, input, settings);
  return failure.code;
}
