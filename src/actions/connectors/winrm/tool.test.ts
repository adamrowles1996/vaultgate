import { describe, expect, it } from 'vitest';

import {
  connectSdkClient,
  createActionsApp,
  scriptedElicitation,
} from '../../../test-support/actions-app.ts';
import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import { fakeWsman, type FakeWsman } from '../../../test-support/fake-wsman.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { createWinrmTarget, winrmConnectorOver } from '../../../test-support/winrm-connector.ts';

import type { ActionsApp } from '../../../test-support/actions-app.ts';

const WINRM_ON = { VAULTGATE_ACTIONS_ENABLE_WINRM: 'true' } as const;

function appOver(fake: FakeWsman): ActionsApp {
  return createActionsApp({ config: WINRM_ON, runtime: winrmConnectorOver(fake) });
}

describe('winrm_run through the MCP client SDK', () => {
  it('ACT-27 ACT-51 runs the command and returns both streams with the credential scrubbed', async () => {
    const fake = fakeWsman({
      receives: [
        { stdout: `password=${CANARY.password}`, stderr: 'warning', done: true, exitCode: 0 },
      ],
    });
    const { app, harness, issue } = appOver(fake);
    await createWinrmTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:winrm']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'winrm_run',
      arguments: { target: 'build-agent', command: 'Get-ComputerInfo', stdin: 'nothing' },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      exit_code: 0,
      stdout: 'password=[redacted:password]',
      stderr: 'warning',
      truncated: false,
    });
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Send', 'Receive', 'Delete']);
    expect(JSON.stringify(result)).not.toContain(CANARY.password);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', tool: 'winrm_run', operation: 'shell', classification: 'command' },
    ]);
  });

  it('ACT-39 refuses a command outside the allowlist with the reason, and nothing connects', async () => {
    const fake = fakeWsman();
    const { app, harness, issue } = appOver(fake);
    await createWinrmTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:winrm']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'winrm_run',
      arguments: { target: 'build-agent', command: 'Stop-Computer' },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: 'policy_denied',
      detail: { reason: 'command' },
    });
    expect(fake.requests).toStrictEqual([]);
  });

  it('ACT-40 ACT-43 asks a human to confirm the shell call and runs it once they accept', async () => {
    const fake = fakeWsman();
    const { app, harness, issue } = appOver(fake);
    await createWinrmTarget(harness, { policy: { confirm_writes: true } });
    const elicitation = scriptedElicitation([{ action: 'accept', content: { confirm: true } }]);
    const client = await connectSdkClient(app, {
      token: issue(['actions:winrm']),
      elicitation: elicitation.handler,
    });
    const result = await client.callTool({
      name: 'winrm_run',
      arguments: { target: 'build-agent', command: 'Get-ComputerInfo' },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(elicitation.shown)).toContain('Get-ComputerInfo');
    expect(JSON.stringify(elicitation.shown)).toContain(
      'vaultgate@win.example.com:5986 (powershell)',
    );
    expect(fake.actions).toContain('Command');
  });

  it('ACT-17 ACT-18 ACT-15 tools/list advertises winrm_run with target first, the 13.6.1 annotations and strict schemas', async () => {
    const { app, issue } = appOver(fakeWsman());
    const client = await connectSdkClient(app, {
      token: issue(['actions:winrm']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    const tool = listed.tools.find((candidate) => candidate.name === 'winrm_run');
    expect(tool?.annotations).toStrictEqual({
      title: 'WinRM command',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool?.description).toContain('tls_error');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['target', 'command'],
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toStrictEqual([
      'target',
      'command',
      'stdin',
    ]);
    expect(tool?.outputSchema).toMatchObject({ additionalProperties: false });
    expect(Object.keys(tool?.outputSchema?.['properties'] ?? {})).toStrictEqual([
      'exit_code',
      'stdout',
      'stderr',
      'truncated',
      'duration_ms',
    ]);
  });

  it('ACT-14 a token without actions:winrm cannot see or call the tool', async () => {
    const { app, harness, issue } = appOver(fakeWsman());
    await createWinrmTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:ssh']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('winrm_run');
  });
});
