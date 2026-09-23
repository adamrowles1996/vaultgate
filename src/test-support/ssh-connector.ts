/**
 * What the `ssh` connector's contract tests run against (ACT-75, ACT-78):
 * the real connector over a fake client, a granted `ssh` target on the
 * fixture SSH-key item, and a `RunContext` built by hand so `run` can be
 * driven without the engine.
 */
import { createSshConnector, type SshConnector } from '../actions/connectors/ssh/index.ts';
import { SSH_RUN_TOOL } from '../actions/connectors/ssh/operation.ts';
import {
  sshPolicySchema,
  type SshCredential,
  type SshDestination,
  type SshPolicy,
} from '../actions/connectors/ssh/schemas.ts';

import { actionsEnabled } from './actions-config.ts';
import {
  createActionsHarness,
  OPERATOR_ID,
  PUBLIC_ADDRESS,
  CLIENT_ID,
  type ActionsHarness,
  type HarnessOptions,
} from './actions-fixtures.ts';
import { fakeSshClient, HOST_KEYS, type FakeSsh, type FakeSshOptions } from './fake-ssh-client.ts';
import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';
import { recordedSupport, type RecordedSupport } from './run-support.ts';
import { CANARY } from './vault-fixture.ts';

import type { SshRunContext } from '../actions/connectors/ssh/run.ts';
import type { Invocation } from '../actions/engine-resolve.ts';
import type { TargetSummary } from '../actions/targets.ts';

export const SSH_HOST = 'build.example.com';
export const SSH_USERNAME = 'vaultgate';

export interface SshTargetOverrides {
  readonly name?: string;
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly itemId?: string;
  readonly mapping?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly internal?: boolean;
  readonly grantTo?: readonly string[];
}

export function sshTargetInput(overrides: SshTargetOverrides = {}): Record<string, unknown> {
  return {
    name: overrides.name ?? 'build-host',
    description: 'The build server',
    connector: 'ssh',
    destination: {
      host: SSH_HOST,
      username: SSH_USERNAME,
      host_key: HOST_KEYS.pinned,
      ...overrides.destination,
    },
    internal: overrides.internal ?? false,
    credential: {
      item_id: overrides.itemId ?? 'item-ssh',
      mapping: { auth: 'key', ...overrides.mapping },
    },
    policy: { allowed_commands: ['uptime'], ...overrides.policy },
    enabled: true,
  };
}

export async function createSshTarget(
  harness: ActionsHarness,
  overrides: SshTargetOverrides = {},
): Promise<TargetSummary> {
  const created = unwrapOk(
    await harness.engine.targets.create(sshTargetInput(overrides), OPERATOR_ID),
  );
  const grantees = overrides.grantTo ?? [CLIENT_ID];
  for (const clientId of grantees) {
    unwrapOk(harness.engine.targets.grant(created.id, clientId, OPERATOR_ID));
  }
  return harness.engine.targets.get(created.id) ?? created;
}

/**
An `ssh_run` call on the fixture target; `target` inside the arguments names the target.
*/
export function sshInvocation(toolArguments: Readonly<Record<string, unknown>> = {}): Invocation {
  const merged = { target: 'build-host', command: 'uptime', ...toolArguments };
  return { tool: SSH_RUN_TOOL, target: merged.target, arguments: merged };
}

export function sshConnectorOver(fake: FakeSsh, isAnyCommandAllowed = false): SshConnector {
  return createSshConnector({ allowAnyCommand: isAnyCommandAllowed }, fake.open);
}

export interface OverSsh {
  readonly fake: FakeSsh;
  readonly harness: ActionsHarness;
}

export interface OverSshOptions extends Omit<HarnessOptions, 'runtime' | 'config'> {
  readonly allowAnyCommand?: boolean;
}

/**
An engine harness whose loaded runtime is the real `ssh` connector over a fake client.
*/
export function harnessOverSsh(
  options: FakeSshOptions = {},
  harnessOptions: OverSshOptions = {},
): OverSsh {
  const { allowAnyCommand: isAnyCommandAllowed = false, ...rest } = harnessOptions;
  const fake = fakeSshClient(options);
  return {
    fake,
    harness: createActionsHarness({
      config: actionsEnabled(['ssh'], { allowAnyCommand: isAnyCommandAllowed }),
      addresses: { [SSH_HOST]: [PUBLIC_ADDRESS] },
      ...rest,
      runtime: sshConnectorOver(fake, isAnyCommandAllowed),
    }),
  };
}

export interface SshContextOptions {
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly credential?: SshCredential;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly pinned?: SshRunContext['pinned'];
  readonly maxOutputBytes?: number;
}

export interface BuiltSshContext {
  readonly context: SshRunContext;
  readonly controller: AbortController;
  readonly logged: () => readonly Record<string, unknown>[];
  readonly support: RecordedSupport;
}

const KEY_FIELD = 'sshKey.privateKey';

/**
A key-authenticated target on the fixture private key with the default policy, unless told otherwise.
*/
export function sshRunContext(options: SshContextOptions = {}): BuiltSshContext {
  const destination: SshDestination = {
    host: SSH_HOST,
    port: 22,
    username: SSH_USERNAME,
    host_key: HOST_KEYS.pinned,
    ...options.destination,
  };
  const credential: SshCredential = options.credential ?? {
    auth: 'key',
    key_field: KEY_FIELD,
  };
  const policy: SshPolicy = sshPolicySchema.parse({
    allowed_commands: ['uptime'],
    ...options.policy,
  });
  const secrets = options.secrets ?? { [KEY_FIELD]: CANARY.sshPrivateKey };
  const support = recordedSupport({
    entries: Object.entries(secrets).map(([field, value]) => ({
      field,
      value: Buffer.from(value, 'utf8'),
    })),
    username: undefined,
    target: { name: 'build-host' },
  });
  const controller = new AbortController();
  const { logger, lines } = captureLogger();
  return {
    controller,
    support,
    logged: lines,
    context: {
      destination,
      credential,
      policy,
      common: policy,
      tool: SSH_RUN_TOOL,
      injected: support.secrets.injected,
      support: support.support,
      pinned: options.pinned ?? [{ host: SSH_HOST, tls: true, address: PUBLIC_ADDRESS }],
      signal: controller.signal,
      outputLimit: {
        maxBytes: options.maxOutputBytes ?? policy.max_output_bytes,
        get guardBytes() {
          return support.secrets.scrub.guardBytes;
        },
      },
      logger,
    },
  };
}
