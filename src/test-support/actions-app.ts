/**
 * The in-process app with the actions engine behind `/mcp` (one audit trail
 * for the route and the engine), the real MCP client SDK connected to it on
 * the 2026-07-28 wire, and a raw `tools/call` for the cases the SDK's driver
 * cannot script.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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

export interface SdkClientOptions {
  readonly token: string;
}

/**
The SDK client pinned to 2026-07-28, the wire a current client speaks.
*/
export async function connectSdkClient(app: App, options: SdkClientOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(TEST_RESOURCE), {
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
    authProvider: { token: () => Promise.resolve(options.token) },
  });
  const client = new Client(
    { name: 'contract', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  return client;
}

export interface RawCallOptions {
  readonly token: string;
}

/**
The `result` of one `tools/call` on the 2026-07-28 wire, as JSON.
*/
export async function rawCall(
  app: App,
  options: RawCallOptions,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await postJsonRpc(app, request('tools/call', parameters), {
    token: options.token,
    protocolVersion: MODERN_PROTOCOL_VERSION,
  });
  const message = response.message as { readonly result?: Record<string, unknown> } | undefined;
  return message?.result ?? { status: response.status, text: response.text };
}
