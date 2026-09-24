import { describe, expect, it } from 'vitest';

import { SCOPES } from '../scopes/registry.ts';
import { createActionsApp } from '../test-support/actions-app.ts';
import {
  initializeRequest,
  LEGACY_PROTOCOL_VERSION,
  postJsonRpc,
} from '../test-support/mcp-client.ts';
import { createTestApp, type TestApp } from '../test-support/test-app.ts';

const VAULT_LEAD = 'vaultgate exposes one Bitwarden vault.';
const ACTIONS_LEAD = 'vaultgate lets you use the credentials in one Bitwarden vault without seeing';

async function instructionsFor(app: TestApp['app'], token: string): Promise<string> {
  const response = await postJsonRpc(app, initializeRequest(LEGACY_PROTOCOL_VERSION), {
    token,
    protocolVersion: LEGACY_PROTOCOL_VERSION,
  });
  expect(response.status).toBe(200);
  const message = response.message as { result?: { instructions?: unknown } };
  const instructions = message.result?.instructions;
  expect(instructions).toBeTypeOf('string');
  return String(instructions);
}

describe('MCP-16 the handshake instructions', () => {
  it('MCP-16 describe the vault tools when the deployment has no actions layer', async () => {
    const { app, verifier } = createTestApp();
    const instructions = await instructionsFor(app, verifier.issue({ scopes: [...SCOPES] }));
    expect(instructions.startsWith(VAULT_LEAD)).toBe(true);
    expect(instructions).not.toContain('actions_list_targets');
  });

  it('MCP-16 describe the vault tools to a token without an actions scope', async () => {
    const { app, issue } = createActionsApp();
    const instructions = await instructionsFor(app, issue(['vault:read', 'vault:reveal']));
    expect(instructions.startsWith(VAULT_LEAD)).toBe(true);
  });

  it('MCP-16 steer a token that can use actions to them rather than to get_secret', async () => {
    const { app, issue } = createActionsApp();
    const instructions = await instructionsFor(app, issue(['vault:read', 'actions:http']));
    expect(instructions.startsWith(ACTIONS_LEAD)).toBe(true);
    expect(instructions).toContain('actions_list_targets');
    expect(instructions).toContain('Prefer an action to get_secret');
  });
});
