/**
 * What the `code` connector's contract tests run against (ACT-117): the real
 * connector over a fake GitHub and a fake sidecar inside the engine harness,
 * granted code targets on the fixture login item whose password is the token
 * (a canary, ACT-53), and the invocations the MCP layer would make.
 */
import { createCodeConnector, type CodeConnector } from '../actions/connectors/code/index.ts';

import { actionsEnabled } from './actions-config.ts';
import {
  type ActionsHarness,
  caller,
  CLIENT_ID,
  createActionsHarness,
  type HarnessOptions,
  OPERATOR_ID,
} from './actions-fixtures.ts';
import {
  createFakeSidecar,
  type FakeSidecar,
  type FakeSidecarOptions,
} from './fake-code-sidecar.ts';
import {
  createFakeGitHub,
  type FakeGitHub,
  type FakeGitHubOptions,
  type FakeRepo,
} from './fake-github.ts';
import { unwrapOk } from './result.ts';
import { CANARY } from './vault-fixture.ts';

import type { Caller } from '../actions/caller.ts';
import type { GitHubAccess } from '../actions/connectors/code/github-http.ts';
import type { Invocation } from '../actions/engine-resolve.ts';
import type { TargetSummary } from '../actions/targets.ts';

export const REPO = 'acme/widgets';
export const OTHER_REPO = 'acme/gadgets';
export const CODE_URL = 'unix:/run/vaultgate-code/sidecar.sock';

export const SHA = {
  main: 'a'.repeat(40),
  tag: 'b'.repeat(40),
  pull: 'c'.repeat(40),
  moved: 'd'.repeat(40),
  other: 'e'.repeat(40),
} as const;

/**
Bytes that stand for the gzip tar GitHub sends; the fake sidecar never opens them.
*/
export const ARCHIVE = Buffer.from('fake gzip tar of acme/widgets: ARCHIVE-CONTENT-MARKER', 'utf8');

export function fakeRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    fullName: REPO,
    defaultBranch: 'main',
    isPrivate: true,
    refs: { main: SHA.main, 'v1.0': SHA.tag, 'feature/x': SHA.moved },
    pulls: { 7: SHA.pull },
    archives: {
      [SHA.main]: ARCHIVE,
      [SHA.tag]: ARCHIVE,
      [SHA.pull]: ARCHIVE,
      [SHA.moved]: ARCHIVE,
      [SHA.other]: ARCHIVE,
    },
    ...overrides,
  };
}

export interface CodeHarness {
  readonly harness: ActionsHarness;
  readonly github: FakeGitHub;
  readonly sidecar: FakeSidecar;
  readonly connector: CodeConnector;
  /**
  Lets every chain the connector started in the background run to its end.
  */
  readonly settle: () => Promise<void>;
}

export interface CodeHarnessOptions {
  readonly github?: Partial<FakeGitHubOptions>;
  readonly sidecar?: Omit<FakeSidecarOptions, 'now'>;
  readonly harness?: Omit<HarnessOptions, 'runtime' | 'config'>;
  /**
  The sidecar does not answer from the start, as when vaultgate starts before it.
  */
  readonly startUnreachable?: boolean;
}

const SETTLE_ROUNDS = 12;

export function createCodeHarness(options: CodeHarnessOptions = {}): CodeHarness {
  const time = { now: (): number => 0 };
  const github = createFakeGitHub({
    repos: [fakeRepo(), fakeRepo({ fullName: OTHER_REPO, refs: { main: SHA.other } })],
    token: CANARY.password,
    ...options.github,
  });
  const sidecar = createFakeSidecar({ ...options.sidecar, now: () => time.now() });
  sidecar.unreachable(options.startUnreachable === true);
  const connector = createCodeConnector({
    url: CODE_URL,
    userAgent: 'vaultgate/9.9.9',
    http: sidecar.http,
    fetch: github.fetch,
  });
  const harness = createActionsHarness({
    ...options.harness,
    config: actionsEnabled(['code'], { codeUrl: CODE_URL }),
    runtime: connector,
  });
  time.now = () => harness.clock.now();
  const settle = async (): Promise<void> => {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      await harness.clock.settle();
    }
  };
  return { harness, github, sidecar, connector, settle };
}

export interface CodeTargetOverrides {
  readonly name?: string;
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly mapping?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly internal?: boolean;
  readonly enabled?: boolean;
  readonly grantTo?: readonly string[];
}

export function codeTargetInput(overrides: CodeTargetOverrides = {}): Record<string, unknown> {
  return {
    name: overrides.name ?? 'widgets',
    description: 'The widgets repository',
    connector: 'code',
    destination: { repository: REPO, ...overrides.destination },
    internal: overrides.internal ?? false,
    credential: {
      item_id: 'item-login',
      mapping: { token_field: 'password', ...overrides.mapping },
    },
    policy: { ...overrides.policy },
    enabled: overrides.enabled ?? true,
  };
}

/**
Creates and grants the target, then lets the save-triggered build run (ACT-108).
*/
export async function createCodeTarget(
  code: CodeHarness,
  overrides: CodeTargetOverrides = {},
): Promise<TargetSummary> {
  const { engine } = code.harness;
  const created = unwrapOk(await engine.targets.create(codeTargetInput(overrides), OPERATOR_ID));
  const grantees = overrides.grantTo ?? [CLIENT_ID];
  for (const clientId of grantees) {
    unwrapOk(engine.targets.grant(created.id, clientId, OPERATOR_ID));
  }
  await code.settle();
  return engine.targets.get(created.id) ?? created;
}

/**
An edit of the target to these fields (everything but its name, connector and switch), then a settle.
*/
export async function updateCodeTarget(
  code: CodeHarness,
  id: string,
  overrides: CodeTargetOverrides = {},
): Promise<TargetSummary> {
  const {
    name: _name,
    connector: _connector,
    enabled: _enabled,
    ...changes
  } = codeTargetInput(overrides);
  const updated = unwrapOk(await code.harness.engine.targets.update(id, changes, OPERATOR_ID));
  await code.settle();
  return updated;
}

export const CODE_SCOPES = ['actions:code'] as const;

export function codeCaller(overrides: Partial<Caller> = {}): Caller {
  return caller({ scopes: [...CODE_SCOPES], ...overrides });
}

/**
A code tool call as the MCP layer makes it: `repo` in the arguments and every name in `targets`.
*/
export function codeInvocation(
  tool: string,
  repo: string | readonly string[],
  toolArguments: Readonly<Record<string, unknown>> = {},
): Invocation {
  const targets = typeof repo === 'string' ? [repo] : [...repo];
  return { tool, target: targets.join(','), targets, arguments: { repo, ...toolArguments } };
}

export function search(
  repo: string | readonly string[],
  toolArguments: Readonly<Record<string, unknown>> = {},
): Invocation {
  return codeInvocation('code_search', repo, { query: 'where are widgets made', ...toolArguments });
}

/**
One search result as the fake sidecar answers it, for the `answer` option.
*/
export function sidecarResult(label: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    label,
    file_path: 'src/widget.ts',
    start_line: 10,
    end_line: 20,
    score: 0.83,
    language: 'typescript',
    content: 'export function makeWidget() {}',
    ...overrides,
  };
}

export interface RecordedAccess {
  readonly access: GitHubAccess;
  readonly captured: { readonly field: string; readonly value: string }[];
  readonly controller: AbortController;
}

export const API_ADDRESS = '140.82.121.6';
export const ARCHIVE_ADDRESS = '140.82.121.9';

/**
The GitHub access a call would hand over, over `fetch`, recording every value it captures.
*/
export function recordedAccess(
  fetch: GitHubAccess['fetch'],
  overrides: Partial<Omit<GitHubAccess, 'fetch' | 'capture' | 'signal'>> = {},
): RecordedAccess {
  const captured: RecordedAccess['captured'] = [];
  const controller = new AbortController();
  return {
    captured,
    controller,
    access: {
      fetch,
      apiAddress: API_ADDRESS,
      archiveAddress: ARCHIVE_ADDRESS,
      token: CANARY.password,
      userAgent: 'vaultgate/9.9.9',
      scrub: (text) => text,
      ...overrides,
      signal: controller.signal,
      capture: (field, value) => {
        captured.push({ field, value: value.toString('utf8') });
      },
    },
  };
}
