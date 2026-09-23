import type { App } from '../http/app.ts';

/**
 * The two wire formats the SDK serves: the 2025 handshake (`initialize`) and
 * the 2026-07-28 per-request envelope (spec MCP-2).
 */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export type ProtocolVersion = typeof LEGACY_PROTOCOL_VERSION | typeof MODERN_PROTOCOL_VERSION;
export const PROTOCOL_VERSIONS: readonly ProtocolVersion[] = [
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
];

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export interface RpcOptions {
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: unknown;
  /**
  Defaults to the 2025 wire format; `2026-07-28` adds the envelope and per-request headers.
  */
  readonly protocolVersion?: ProtocolVersion;
  /**
  What the 2026-07-28 envelope declares as client capabilities; empty by default.
  */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

export interface RpcResponse {
  readonly status: number;
  readonly headers: Headers;
  /**
  The first JSON-RPC message, whether the SDK answered as JSON or as one SSE event.
  */
  readonly message: unknown;
  readonly text: string;
}

/**
Every header a well-behaved Streamable HTTP client sends, so tests only spell out what they vary.
*/
export function mcpHeaders(
  token: string | undefined,
  extra: Readonly<Record<string, string>> = {},
  protocolVersion: ProtocolVersion = LEGACY_PROTOCOL_VERSION,
): Record<string, string> {
  return {
    host: 'vault.example.com',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': protocolVersion,
    ...(token !== undefined && { authorization: `Bearer ${token}` }),
    ...extra,
  };
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isPlainObject(value) && typeof value['method'] === 'string' && 'id' in value;
}

/**
 * The 2026-07-28 per-request envelope: `params._meta` names the revision and
 * the client's capabilities on every request (the SDK rejects a modern
 * `Mcp-Protocol-Version` header without it).
 */
function enveloped(
  message: JsonRpcRequest,
  clientCapabilities: Readonly<Record<string, unknown>> = {},
): JsonRpcRequest {
  const parameters = isPlainObject(message.params) ? message.params : {};
  const meta = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities,
  };
  return { ...message, params: { ...parameters, _meta: meta } };
}

/**
 * The per-request headers of the 2026-07-28 wire format (SEP-2243):
 * `Mcp-Method` on every request and `Mcp-Name` mirroring `params.name`.
 */
function perRequestHeaders(message: JsonRpcRequest): Record<string, string> {
  const name = isPlainObject(message.params) ? message.params['name'] : undefined;
  return {
    'mcp-method': message.method,
    ...(typeof name === 'string' && { 'mcp-name': name }),
  };
}

function firstMessage(text: string): unknown {
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  const candidate = events[0] ?? text;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/**
Posts one message the way a client of the chosen protocol version would; a string body goes as-is.
*/
export async function postJsonRpc(
  app: App,
  body: unknown,
  options: RpcOptions = {},
): Promise<RpcResponse> {
  const version = options.protocolVersion ?? LEGACY_PROTOCOL_VERSION;
  const modern =
    version === MODERN_PROTOCOL_VERSION && isJsonRpcRequest(body)
      ? enveloped(body, options.clientCapabilities)
      : undefined;
  const message = modern ?? body;
  const extra = { ...(modern !== undefined && perRequestHeaders(modern)), ...options.headers };
  const response = await app.request(
    '/mcp',
    {
      method: 'POST',
      headers: mcpHeaders(options.token, extra, version),
      body: typeof message === 'string' ? message : JSON.stringify(message),
    },
    options.env,
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, message: firstMessage(text), text };
}

const ids = { next: 0 };

export function request(method: string, parameters: unknown = {}): JsonRpcRequest {
  ids.next += 1;
  return { jsonrpc: '2.0', id: ids.next, method, params: parameters };
}

export function initializeRequest(
  protocolVersion: ProtocolVersion = LEGACY_PROTOCOL_VERSION,
): JsonRpcRequest {
  return request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
}

export interface ToolCallOutcome {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly contentText: string | undefined;
}

interface CallToolShape {
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
  };
}

/**
Issues one `tools/call` and unpacks the result envelope; a non-200 answer has no result.
*/
export async function callTool(
  app: App,
  name: string,
  input: unknown,
  options: RpcOptions = {},
): Promise<ToolCallOutcome> {
  const response = await postJsonRpc(
    app,
    request('tools/call', { name, arguments: input }),
    options,
  );
  const result = (response.message as CallToolShape | undefined)?.result;
  return {
    status: response.status,
    headers: response.headers,
    text: response.text,
    isError: result?.isError ?? false,
    structuredContent: result?.structuredContent,
    contentText: result?.content?.find((block) => block.type === 'text')?.text,
  };
}

interface ListToolsShape {
  readonly result?: { readonly tools?: readonly { readonly name: string }[] };
}

export async function listToolNames(
  app: App,
  options: RpcOptions = {},
): Promise<readonly string[]> {
  const response = await postJsonRpc(app, request('tools/list'), options);
  const tools = (response.message as ListToolsShape | undefined)?.result?.tools ?? [];
  return tools.map((tool) => tool.name);
}
