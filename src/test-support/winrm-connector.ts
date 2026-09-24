/**
 * What the `winrm` connector's contract tests run against (ACT-75, ACT-78):
 * the real connector over a fake WS-Management destination, a granted `winrm`
 * target on the fixture login item, and a `RunContext` built by hand so `run`
 * can be driven without the engine.
 */
import { winrmSessionOver } from '../actions/connectors/winrm/client.ts';
import { createWinrmConnector, type WinrmConnector } from '../actions/connectors/winrm/index.ts';
import { WINRM_RUN_TOOL } from '../actions/connectors/winrm/operation.ts';
import {
  winrmPolicySchema,
  type WinrmCredential,
  type WinrmDestination,
  type WinrmPolicy,
} from '../actions/connectors/winrm/schemas.ts';

import { actionsEnabled } from './actions-config.ts';
import {
  createActionsHarness,
  CLIENT_ID,
  OPERATOR_ID,
  PUBLIC_ADDRESS,
  type ActionsHarness,
  type HarnessOptions,
} from './actions-fixtures.ts';
import { fakeWsman, type FakeWsman, type FakeWsmanOptions } from './fake-wsman.ts';
import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';
import { recordedSupport, type RecordedSupport } from './run-support.ts';
import { CANARY } from './vault-fixture.ts';

import type { WinrmRunContext } from '../actions/connectors/winrm/run.ts';
import type { WinrmSessionFactory } from '../actions/connectors/winrm/session.ts';
import type { Invocation } from '../actions/engine-resolve.ts';
import type { TargetSummary } from '../actions/targets.ts';

export const WINRM_HOST = 'win.example.com';
export const WINRM_URL = `https://${WINRM_HOST}:5986/wsman`;
export const WINRM_USERNAME = 'vaultgate';
export const PASSWORD_FIELD = 'password';

/**
The SHA-256 of the certificate `fakeTlsSocket` would present; a pinned target uses it.
*/
export const CERTIFICATE_SHA256 =
  'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';

/**
Message identifiers in order, so a test can assert the exact envelopes (ACT-75).
*/
export function countingIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

export function winrmSessionOverFake(
  fake: FakeWsman,
  cleanup: AbortSignal = new AbortController().signal,
): WinrmSessionFactory {
  return winrmSessionOver({
    transport: fake.transport,
    version: '9.9.9',
    newId: countingIds(),
    cleanupSignal: () => cleanup,
  });
}

export function winrmConnectorOver(fake: FakeWsman, isAnyCommandAllowed = false): WinrmConnector {
  return createWinrmConnector({ allowAnyCommand: isAnyCommandAllowed }, winrmSessionOverFake(fake));
}

export interface WinrmTargetOverrides {
  readonly name?: string;
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly itemId?: string;
  readonly mapping?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly internal?: boolean;
  readonly grantTo?: readonly string[];
}

export function winrmTargetInput(overrides: WinrmTargetOverrides = {}): Record<string, unknown> {
  return {
    name: overrides.name ?? 'build-agent',
    description: 'The Windows build agent',
    connector: 'winrm',
    destination: { url: WINRM_URL, username: WINRM_USERNAME, ...overrides.destination },
    internal: overrides.internal ?? false,
    credential: { item_id: overrides.itemId ?? 'item-login', mapping: { ...overrides.mapping } },
    policy: { allowed_commands: ['Get-ComputerInfo'], ...overrides.policy },
    enabled: true,
  };
}

export async function createWinrmTarget(
  harness: ActionsHarness,
  overrides: WinrmTargetOverrides = {},
): Promise<TargetSummary> {
  const created = unwrapOk(
    await harness.engine.targets.create(winrmTargetInput(overrides), OPERATOR_ID),
  );
  const grantees = overrides.grantTo ?? [CLIENT_ID];
  for (const clientId of grantees) {
    unwrapOk(harness.engine.targets.grant(created.id, clientId, OPERATOR_ID));
  }
  return harness.engine.targets.get(created.id) ?? created;
}

/**
A `winrm_run` call on the fixture target; `target` inside the arguments names the target.
*/
export function winrmInvocation(toolArguments: Readonly<Record<string, unknown>> = {}): Invocation {
  const merged = { target: 'build-agent', command: 'Get-ComputerInfo', ...toolArguments };
  return { tool: WINRM_RUN_TOOL, target: merged.target, arguments: merged };
}

export interface OverWinrm {
  readonly fake: FakeWsman;
  readonly harness: ActionsHarness;
}

export interface OverWinrmOptions extends Omit<HarnessOptions, 'runtime' | 'config'> {
  readonly allowAnyCommand?: boolean;
}

/**
An engine harness whose loaded runtime is the real `winrm` connector over a fake destination.
*/
export function harnessOverWinrm(
  options: FakeWsmanOptions = {},
  harnessOptions: OverWinrmOptions = {},
): OverWinrm {
  const { allowAnyCommand: isAnyCommandAllowed = false, ...rest } = harnessOptions;
  const fake = fakeWsman(options);
  return {
    fake,
    harness: createActionsHarness({
      config: actionsEnabled(['winrm'], { allowAnyCommand: isAnyCommandAllowed }),
      addresses: { [WINRM_HOST]: [PUBLIC_ADDRESS] },
      ...rest,
      runtime: winrmConnectorOver(fake, isAnyCommandAllowed),
    }),
  };
}

export interface WinrmContextOptions {
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly credential?: WinrmCredential;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly pinned?: WinrmRunContext['pinned'];
  readonly maxOutputBytes?: number;
}

export interface BuiltWinrmContext {
  readonly context: WinrmRunContext;
  readonly controller: AbortController;
  readonly logged: () => readonly Record<string, unknown>[];
  readonly support: RecordedSupport;
}

/**
A password-authenticated target on the fixture password with the default policy, unless told otherwise.
*/
export function winrmRunContext(options: WinrmContextOptions = {}): BuiltWinrmContext {
  const destination: WinrmDestination = {
    url: WINRM_URL,
    username: WINRM_USERNAME,
    shell: 'powershell',
    certificate_sha256: undefined,
    ...options.destination,
  };
  const credential: WinrmCredential = options.credential ?? { password_field: PASSWORD_FIELD };
  const policy: WinrmPolicy = winrmPolicySchema.parse({
    allowed_commands: ['Get-ComputerInfo'],
    ...options.policy,
  });
  const secrets = options.secrets ?? { [PASSWORD_FIELD]: CANARY.password };
  const support = recordedSupport({
    entries: Object.entries(secrets).map(([field, value]) => ({
      field,
      value: Buffer.from(value, 'utf8'),
    })),
    username: undefined,
    target: { name: 'build-agent' },
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
      tool: WINRM_RUN_TOOL,
      injected: support.secrets.injected,
      support: support.support,
      pinned: options.pinned ?? [{ host: WINRM_HOST, tls: true, address: PUBLIC_ADDRESS }],
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
