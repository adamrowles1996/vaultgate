/**
 * The `ssh` connector's target documents (spec §14.5). The schemas are the
 * static half every build carries so the account page can validate and edit
 * targets; the runtime is `./index.ts`. The host key is required and parsed
 * here, so a target that could never be verified cannot be saved (ACT-87),
 * and a policy names either command patterns or `any_command`, never both
 * and never neither (ACT-88).
 */
import { z } from 'zod';

import { commonPolicySchema } from '../../policy.ts';

import { hostKeyProblem } from './host-key.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const DEFAULT_PORT = 22;

const MAX_PORT = 65_535;

const hostKeySchema = z.string().superRefine((text, context) => {
  const problem = hostKeyProblem(text);
  if (problem !== undefined) {
    context.addIssue({ code: 'custom', message: problem });
  }
});

export const sshDestinationSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  /**
  The account the command runs as; §14.5 puts it in the destination, so one vault item can serve several targets.
  */
  username: z.string().min(1),
  /**
  ACT-87: required. There is no trust-on-first-use and no way to skip verification.
  */
  host_key: hostKeySchema,
});

const fieldSelectorSchema = z.string().min(1);

export const sshCredentialSchema = z.discriminatedUnion('auth', [
  z.strictObject({
    auth: z.literal('key'),
    key_field: fieldSelectorSchema.default('sshKey.privateKey'),
    passphrase_field: fieldSelectorSchema.optional(),
  }),
  z.strictObject({
    auth: z.literal('password'),
    password_field: fieldSelectorSchema.default('password'),
  }),
]);

export const sshPolicySchema = commonPolicySchema.extend({
  allowed_commands: z.array(z.string().min(1)).default([]),
  /**
  ACT-88: accepted at save only on a deployment with `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`.
  */
  any_command: z.boolean().default(false),
});

export type SshDestination = z.output<typeof sshDestinationSchema>;
export type SshCredential = z.output<typeof sshCredentialSchema>;
export type SshPolicy = z.output<typeof sshPolicySchema>;

/**
ACT-57: the SSH transport is always encrypted, so an `ssh` target never needs `internal` for that reason.
*/
function endpoints(destination: SshDestination): readonly Endpoint[] {
  return [{ host: destination.host, tls: true }];
}

function field(selector: string): CredentialField {
  return { name: selector, selector, role: 'secret' };
}

/**
The login name lives in the destination (§14.5), so nothing here has the `username` role.
*/
function credentialFields(credential: SshCredential): readonly CredentialField[] {
  if (credential.auth === 'password') {
    return [field(credential.password_field)];
  }
  return credential.passphrase_field === undefined
    ? [field(credential.key_field)]
    : [field(credential.key_field), field(credential.passphrase_field)];
}

/**
ACT-88: exactly one of the two; a target with neither would allow nothing and is a mistake, not a lock.
*/
function commandProblems(policy: SshPolicy): readonly string[] {
  if (policy.any_command) {
    return policy.allowed_commands.length === 0
      ? []
      : ['policy: set either allowed_commands or any_command, not both'];
  }
  return policy.allowed_commands.length === 0
    ? ['policy.allowed_commands: give at least one command pattern, or set any_command']
    : [];
}

export const sshSchemas: ConnectorSchemas<SshDestination, SshCredential, SshPolicy> = {
  kind: 'ssh',
  destinationSchema: sshDestinationSchema,
  credentialSchema: sshCredentialSchema,
  policySchema: sshPolicySchema,
  endpoints,
  credentialFields,
  saveProblems({ policy }) {
    return commandProblems(policy);
  },
  summariseDestination(destination) {
    return `${destination.username}@${destination.host}:${destination.port}`;
  },
};
