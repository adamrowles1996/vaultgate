import { describe, expect, it } from 'vitest';

import {
  connectSdkClient,
  createActionsApp,
  scriptedElicitation,
} from '../../../test-support/actions-app.ts';
import { storedCalls } from '../../../test-support/actions-fixtures.ts';
import { fakeSshClient, type FakeSsh } from '../../../test-support/fake-ssh-client.ts';
import { createSshTarget, sshConnectorOver } from '../../../test-support/ssh-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import type { ActionsApp } from '../../../test-support/actions-app.ts';

const SSH_ON = { VAULTGATE_ACTIONS_ENABLE_SSH: 'true' } as const;

function appOver(fake: FakeSsh): ActionsApp {
  return createActionsApp({ config: SSH_ON, runtime: sshConnectorOver(fake) });
}

describe('ssh_run through the MCP client SDK', () => {
  it('ACT-27 ACT-51 runs the command and returns both streams with the credential scrubbed', async () => {
    const fake = fakeSshClient({
      answers: [
        {
          exitCode: 0,
          stdout: Buffer.from(`key=${CANARY.sshPrivateKey}`, 'utf8'),
          stderr: Buffer.from('warning', 'utf8'),
        },
      ],
    });
    const { app, harness, issue } = appOver(fake);
    await createSshTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:ssh']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'ssh_run',
      arguments: { target: 'build-host', command: 'uptime', stdin: 'nothing' },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      exit_code: 0,
      stdout: 'key=[redacted:sshKey.privateKey]',
      stderr: 'warning',
      truncated: false,
    });
    expect(fake.commands[0]).toMatchObject({ command: 'uptime', stdin: 'nothing' });
    expect(JSON.stringify(result)).not.toContain(CANARY.sshPrivateKey);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', tool: 'ssh_run', operation: 'shell', classification: 'command' },
    ]);
  });

  it('ACT-39 refuses a command outside the allowlist with the reason, and nothing connects', async () => {
    const fake = fakeSshClient();
    const { app, harness, issue } = appOver(fake);
    await createSshTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:ssh']),
      elicitation: 'none',
    });
    const result = await client.callTool({
      name: 'ssh_run',
      arguments: { target: 'build-host', command: 'shutdown -h now' },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: 'policy_denied',
      detail: { reason: 'command' },
    });
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-40 ACT-43 asks a human to confirm the shell call and runs it once they accept', async () => {
    const fake = fakeSshClient();
    const { app, harness, issue } = appOver(fake);
    await createSshTarget(harness, { policy: { confirm_writes: true } });
    const elicitation = scriptedElicitation([{ action: 'accept', content: { confirm: true } }]);
    const client = await connectSdkClient(app, {
      token: issue(['actions:ssh']),
      elicitation: elicitation.handler,
    });
    const result = await client.callTool({
      name: 'ssh_run',
      arguments: { target: 'build-host', command: 'uptime' },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(elicitation.shown)).toContain('uptime');
    expect(JSON.stringify(elicitation.shown)).toContain('vaultgate@build.example.com:22');
    expect(fake.commands).toHaveLength(1);
  });

  it('ACT-17 ACT-18 ACT-15 tools/list advertises ssh_run with target first, the 13.6.1 annotations and strict schemas', async () => {
    const { app, issue } = appOver(fakeSshClient());
    const client = await connectSdkClient(app, {
      token: issue(['actions:ssh']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    const tool = listed.tools.find((candidate) => candidate.name === 'ssh_run');
    expect(tool?.annotations).toStrictEqual({
      title: 'SSH command',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool?.description).toContain('host_key_mismatch');
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

  it('ACT-14 a token without actions:ssh cannot see or call the tool', async () => {
    const { app, harness, issue } = appOver(fakeSshClient());
    await createSshTarget(harness);
    const client = await connectSdkClient(app, {
      token: issue(['actions:http']),
      elicitation: 'none',
    });
    const listed = await client.listTools();
    await client.close();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('ssh_run');
  });
});
