import type { App } from '../http/app.ts';

const PROTOCOL_VERSION = '2025-11-25';

export interface RpcOptions {
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: unknown;
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
): Record<string, string> {
  return {
    host: 'vault.example.com',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(token !== undefined && { authorization: `Bearer ${token}` }),
    ...extra,
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

export async function postJsonRpc(
  app: App,
  body: unknown,
  options: RpcOptions = {},
): Promise<RpcResponse> {
  const response = await app.request(
    '/mcp',
    {
      method: 'POST',
      headers: mcpHeaders(options.token, options.headers),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    options.env,
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, message: firstMessage(text), text };
}

const ids = { next: 0 };

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export function request(method: string, parameters: unknown = {}): JsonRpcRequest {
  ids.next += 1;
  return { jsonrpc: '2.0', id: ids.next, method, params: parameters };
}

export function initializeRequest(): JsonRpcRequest {
  return request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
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
