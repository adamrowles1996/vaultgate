import { describe, expect, it } from 'vitest';

import { HOST_KEYS } from '../../../test-support/fake-ssh-client.ts';

import {
  sshCredentialSchema,
  sshDestinationSchema,
  sshPolicySchema,
  sshSchemas,
} from './schemas.ts';

import type { z } from 'zod';

const DESTINATION = {
  host: 'build.example.com',
  username: 'vaultgate',
  host_key: HOST_KEYS.pinned,
};

function destination(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { ...DESTINATION, ...overrides };
}

function problems(value: unknown, schema: z.ZodType): string[] {
  const parsed = schema.safeParse(value);
  expect(parsed.success).toBe(false);
  return (parsed.error?.issues ?? []).map(
    (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
  );
}

describe('the ssh destination document', () => {
  it('ACT-1 defaults the port to 22 and keeps the host, login name and pinned key', () => {
    expect(sshDestinationSchema.parse(destination())).toStrictEqual({
      host: 'build.example.com',
      port: 22,
      username: 'vaultgate',
      host_key: HOST_KEYS.pinned,
    });
  });

  it('ACT-87 refuses a host key that is neither a key line nor a SHA256 fingerprint', () => {
    expect(problems(destination({ host_key: 'trust me' }), sshDestinationSchema)).toStrictEqual([
      'host_key: must be a public key line as ssh-keyscan prints it, or a SHA256: fingerprint',
    ]);
  });

  it('ACT-87 has no field that could turn the host-key check off', () => {
    expect(
      problems(destination({ strict_host_key_checking: false }), sshDestinationSchema),
    ).toStrictEqual([': Unrecognized key: "strict_host_key_checking"']);
  });

  it('ACT-57 names the host as an encrypted endpoint, so no ssh target needs internal for transport', () => {
    const parsed = sshDestinationSchema.parse(destination());
    expect(sshSchemas.endpoints(parsed)).toStrictEqual([{ host: 'build.example.com', tls: true }]);
  });

  it('ACT-43 summarises the destination as the login, host and port, never a credential', () => {
    const parsed = sshDestinationSchema.parse(destination({ port: 2222 }));
    expect(sshSchemas.summariseDestination(parsed)).toBe('vaultgate@build.example.com:2222');
  });
});

describe('the ssh credential document', () => {
  it('ACT-4 defaults the key field to sshKey.privateKey and names it as the one secret', () => {
    const credential = sshCredentialSchema.parse({ auth: 'key' });
    expect(credential).toStrictEqual({ auth: 'key', key_field: 'sshKey.privateKey' });
    expect(sshSchemas.credentialFields(credential)).toStrictEqual([
      { name: 'sshKey.privateKey', selector: 'sshKey.privateKey', role: 'secret' },
    ]);
  });

  it('ACT-4 names the passphrase as a second secret when the mapping has one', () => {
    const credential = sshCredentialSchema.parse({
      auth: 'key',
      passphrase_field: 'custom.key-passphrase',
    });
    expect(sshSchemas.credentialFields(credential)).toStrictEqual([
      { name: 'sshKey.privateKey', selector: 'sshKey.privateKey', role: 'secret' },
      {
        name: 'custom.key-passphrase',
        selector: 'custom.key-passphrase',
        role: 'secret',
      },
    ]);
  });

  it('ACT-4 defaults the password field and names it as the one secret; the login name is not a vault field', () => {
    const credential = sshCredentialSchema.parse({ auth: 'password' });
    expect(credential).toStrictEqual({ auth: 'password', password_field: 'password' });
    expect(sshSchemas.credentialFields(credential)).toStrictEqual([
      { name: 'password', selector: 'password', role: 'secret' },
    ]);
  });

  it('ACT-1 refuses a mapping that mixes the two modes', () => {
    expect(problems({ auth: 'password', key_field: 'x' }, sshCredentialSchema)).toStrictEqual([
      ': Unrecognized key: "key_field"',
    ]);
  });
});

const DOCUMENTS = {
  destination: sshDestinationSchema.parse(DESTINATION),
  credential: sshCredentialSchema.parse({ auth: 'key' }),
};

describe('the ssh policy document', () => {
  it('ACT-1 defaults to no command and no any_command, with the common fields', () => {
    expect(sshPolicySchema.parse({})).toMatchObject({
      allowed_commands: [],
      any_command: false,
      timeout_ms: 30_000,
      confirm_writes: false,
    });
  });

  it('ACT-88 refuses a target that sets both allowed_commands and any_command', () => {
    const policy = sshPolicySchema.parse({ allowed_commands: ['uptime'], any_command: true });
    expect(sshSchemas.saveProblems({ ...DOCUMENTS, policy })).toStrictEqual([
      'policy: set either allowed_commands or any_command, not both',
    ]);
  });

  it('ACT-88 refuses a target that sets neither, which would allow nothing at all', () => {
    const policy = sshPolicySchema.parse({});
    expect(sshSchemas.saveProblems({ ...DOCUMENTS, policy })).toStrictEqual([
      'policy.allowed_commands: give at least one command pattern, or set any_command',
    ]);
  });

  it('ACT-88 accepts a target with patterns only and one with any_command only', () => {
    const patterns = sshPolicySchema.parse({ allowed_commands: ['uptime'] });
    const unrestricted = sshPolicySchema.parse({ any_command: true });
    expect(sshSchemas.saveProblems({ ...DOCUMENTS, policy: patterns })).toStrictEqual([]);
    expect(sshSchemas.saveProblems({ ...DOCUMENTS, policy: unrestricted })).toStrictEqual([]);
  });
});
