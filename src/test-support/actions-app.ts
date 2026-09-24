/**
 * The in-process app with the actions engine behind `/mcp` (one audit trail
 * for the route and the engine), the real MCP client SDK connected to it on
 * the 2026-07-28 wire with a scripted elicitation handler, the same client on
 * the 2025 wire (ACT-48, ACT-76), and the raw multi-round-trip retry for the
 * cases the SDK's driver cannot script (replay, expiry, an edited target,
 * altered arguments).
 */
import {
  Client,
  type ElicitRequest,
  type ElicitResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { createActionsHarness, type ActionsHarness, CLIENT_ID } from './actions-fixtures.ts';
import { MODERN_PROTOCOL_VERSION, postJsonRpc, request } from './mcp-client.ts';
import {
  createTestApp,
  TEST_RESOURCE,
  type TestApp,
  testConfig,
  type TestConfigOverrides,
} from './test-app.ts';

import type { EchoConnector } from './fake-connector.ts';
import type { AnyConnector } from '../actions/connectors/connector.ts';
import type { AuditEvent } from '../audit/event.ts';
import type { App } from '../http/app.ts';

export interface ActionsApp extends TestApp {
  readonly harness: ActionsHarness;
  /**
  A token for the granted agent client, with the given scopes.
  */
  readonly issue: (scopes: readonly string[], clientId?: string) => string;
}

export interface ActionsAppOptions {
  readonly config?: TestConfigOverrides;
  readonly connector?: EchoConnector;
  readonly runtime?: AnyConnector;
}

/**
The layer and the `http` connector on, the echo connector loaded, unless told otherwise.
*/
export function createActionsApp(options: ActionsAppOptions = {}): ActionsApp {
  const config = testConfig({
    VAULTGATE_ENABLE_ACTIONS: 'true',
    VAULTGATE_ACTIONS_ENABLE_HTTP: 'true',
    ...options.config,
  });
  const audit: AuditEvent[] = [];
  const harness = createActionsHarness({
    config: config.actions,
    audit,
    ...(options.connector !== undefined && { connector: options.connector }),
    ...(options.runtime !== undefined && { runtime: options.runtime }),
  });
  const app = createTestApp({ config, engine: harness.engine, audit });
  return {
    ...app,
    harness,
    issue: (scopes, clientId = CLIENT_ID) =>
      app.verifier.issue({ scopes, clientId, clientName: 'Agent One' }),
  };
}

export type ElicitationHandler = (elicitation: ElicitRequest) => ElicitResult;

export interface SdkClientOptions {
  readonly token: string;
  /**
  The handler answers every `elicitation/create` and declares form mode; `'none'` declares no elicitation at all.
  */
  readonly elicitation: ElicitationHandler | 'none';
}

/**
 * The SDK client pinned to 2026-07-28, so an `input_required` answer is
 * fulfilled through the handler and the call retried with the collected
 * `inputResponses` and the echoed `requestState` (ACT-45), at most twice.
 */
export async function connectSdkClient(app: App, options: SdkClientOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(TEST_RESOURCE), {
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
    authProvider: { token: () => Promise.resolve(options.token) },
  });
  const client = new Client(
    { name: 'contract', version: '1' },
    {
      capabilities: options.elicitation === 'none' ? {} : { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      inputRequired: { maxRounds: 2 },
    },
  );
  if (options.elicitation !== 'none') {
    const handler = options.elicitation;
    client.setRequestHandler('elicitation/create', (elicitation) => handler(elicitation));
  }
  await client.connect(transport);
  return client;
}

/**
 * The same client on the 2025 wire (ACT-76's second behaviour), declaring
 * form-mode elicitation at `initialize` — which is the only place that wire
 * has to declare it. The SDK refuses a pinned 2025 revision (`pin` is for
 * 2026-07-28 and later), so the era is selected with `mode: 'legacy'`.
 */
export async function connectLegacySdkClient(app: App, options: SdkClientOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(TEST_RESOURCE), {
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
    authProvider: { token: () => Promise.resolve(options.token) },
  });
  const client = new Client(
    { name: 'contract-legacy', version: '1' },
    {
      capabilities: options.elicitation === 'none' ? {} : { elicitation: { form: {} } },
      versionNegotiation: { mode: 'legacy' },
    },
  );
  if (options.elicitation !== 'none') {
    const handler = options.elicitation;
    client.setRequestHandler('elicitation/create', (elicitation) => handler(elicitation));
  }
  await client.connect(transport);
  return client;
}

/**
 * The elicitation answers a scripted client gives, in order, and every
 * request it was shown.
 */
export function scriptedElicitation(answers: readonly ElicitResult[]): {
  readonly handler: ElicitationHandler;
  readonly shown: ElicitRequest[];
} {
  const shown: ElicitRequest[] = [];
  const queue = [...answers];
  return {
    shown,
    handler: (elicitation) => {
      shown.push(elicitation);
      return queue.shift() ?? { action: 'cancel' };
    },
  };
}

export interface RawCallOptions {
  readonly token: string;
  /**
  What the envelope declares; form-mode elicitation unless told otherwise.
  */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

export const FORM_ELICITATION = { elicitation: { form: {} } } as const;

/**
The `result` of one `tools/call` on the 2026-07-28 wire, as JSON; a retry carries the answer and the state.
*/
export async function rawCall(
  app: App,
  options: RawCallOptions,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await postJsonRpc(app, request('tools/call', parameters), {
    token: options.token,
    protocolVersion: MODERN_PROTOCOL_VERSION,
    clientCapabilities: options.clientCapabilities ?? FORM_ELICITATION,
  });
  const message = response.message as { readonly result?: Record<string, unknown> } | undefined;
  return message?.result ?? { status: response.status, text: response.text };
}

export interface Retry {
  readonly requestState: string;
  readonly answer: ElicitResult;
}

export function retryParameters(
  name: string,
  toolArguments: Readonly<Record<string, unknown>>,
  retry: Retry,
): Record<string, unknown> {
  return {
    name,
    arguments: toolArguments,
    inputResponses: { confirm: retry.answer },
    requestState: retry.requestState,
  };
}

export function requestStateOf(result: Record<string, unknown>): string {
  const state = result['requestState'];
  if (typeof state !== 'string') {
    throw new TypeError(`expected an input_required result but got ${JSON.stringify(result)}`);
  }
  return state;
}
