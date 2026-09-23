import { describe, expect, it } from 'vitest';

import { HOST_KEYS } from '../../../test-support/fake-ssh-client.ts';

import { createAuthorize, createCapabilities, describeOperation } from './authorize.ts';
import { MAX_COMMAND_BYTES, SSH_RUN_TOOL } from './operation.ts';
import {
  sshCredentialSchema,
  sshDestinationSchema,
  sshPolicySchema,
  type SshPolicy,
} from './schemas.ts';

import type { SshRequest } from './authorize.ts';

const ALLOWED = createAuthorize({ allowAnyCommand: true });
const RESTRICTED = createAuthorize({ allowAnyCommand: false });

const DESTINATION = sshDestinationSchema.parse({
  host: 'build.example.com',
  username: 'vaultgate',
  host_key: HOST_KEYS.pinned,
});

const CREDENTIAL = sshCredentialSchema.parse({ auth: 'key' });

function policy(overrides: Readonly<Record<string, unknown>> = {}): SshPolicy {
  return sshPolicySchema.parse({
    allowed_commands: ['uptime', 'systemctl status *'],
    ...overrides,
  });
}

function request(overrides: Readonly<Record<string, unknown>> = {}): SshRequest {
  return {
    tool: SSH_RUN_TOOL,
    destination: DESTINATION,
    credential: CREDENTIAL,
    policy: policy(overrides),
  };
}

describe('the ssh policy decision', () => {
  it('ACT-40 allows a command the allowlist matches and calls it a shell operation, so confirm_writes applies', () => {
    expect(ALLOWED(request(), { command: 'uptime', stdin: undefined })).toStrictEqual({
      allowed: true,
      operation: 'shell',
    });
  });

  it('ACT-34 ACT-39 refuses a command no pattern matches with the reason command', () => {
    expect(ALLOWED(request(), { command: 'rm -rf /', stdin: undefined })).toStrictEqual({
      allowed: false,
      reason: 'command',
    });
  });

  it('ACT-34 matches a star against a run of characters but never across a newline', () => {
    expect(
      ALLOWED(request(), { command: 'systemctl status nginx', stdin: undefined }),
    ).toMatchObject({ allowed: true });
    expect(
      ALLOWED(request(), { command: 'systemctl status nginx\nrm -rf /', stdin: undefined }),
    ).toStrictEqual({ allowed: false, reason: 'command' });
  });

  it('ACT-27 ACT-39 refuses a carriage return on a target that is not an any-command one', () => {
    expect(ALLOWED(request(), { command: 'uptime\r', stdin: undefined })).toStrictEqual({
      allowed: false,
      reason: 'command',
    });
  });

  it('ACT-27 ACT-39 refuses a command beyond 16 KiB with the reason command_size', () => {
    const long = 'x'.repeat(MAX_COMMAND_BYTES + 1);
    expect(
      ALLOWED(request({ any_command: true }), { command: long, stdin: undefined }),
    ).toStrictEqual({ allowed: false, reason: 'command_size' });
  });

  it('ACT-88 lets an any-command target run anything, newlines included', () => {
    const unrestricted = request({ allowed_commands: [], any_command: true });
    expect(
      ALLOWED(unrestricted, { command: 'rm -rf /tmp/x\nreboot', stdin: undefined }),
    ).toStrictEqual({ allowed: true, operation: 'shell' });
  });

  it('ACT-88 refuses every call on an any-command target when the deployment no longer allows one', () => {
    const unrestricted = request({ allowed_commands: [], any_command: true });
    expect(RESTRICTED(unrestricted, { command: 'uptime', stdin: undefined })).toStrictEqual({
      allowed: false,
      reason: 'command',
    });
  });
});

describe('the ssh operation description', () => {
  it('ACT-43 ACT-60 summarises the command, capped at 1 KiB, and classifies it as command', () => {
    const long = 'echo '.repeat(500);
    const description = describeOperation(request(), { command: long, stdin: undefined });
    expect(description.summary).toHaveLength(1024);
    expect(description.classification).toBe('command');
  });

  it('ACT-88 records the whole command of an any-command target, which the 4 KiB arguments cap could cut', () => {
    const command = `echo ${'a'.repeat(5000)}`;
    const unrestricted = request({ any_command: true });
    expect(describeOperation(unrestricted, { command, stdin: undefined }).classification).toBe(
      command,
    );
  });
});

describe('the ssh capabilities', () => {
  it('ACT-19 offers the one shell operation behind the actions:ssh scope', () => {
    expect(createCapabilities({ allowAnyCommand: false })(DESTINATION, policy())).toStrictEqual({
      operations: [{ operation: 'shell', scope: 'actions:ssh' }],
    });
  });

  it('ACT-88 marks an any-command target unrestricted', () => {
    expect(
      createCapabilities({ allowAnyCommand: true })(DESTINATION, policy({ any_command: true })),
    ).toStrictEqual({
      operations: [{ operation: 'shell', scope: 'actions:ssh' }],
      unrestricted: true,
    });
  });

  it('ACT-88 offers nothing on an any-command target the deployment no longer allows', () => {
    expect(
      createCapabilities({ allowAnyCommand: false })(DESTINATION, policy({ any_command: true })),
    ).toStrictEqual({ operations: [], unrestricted: true });
  });
});
