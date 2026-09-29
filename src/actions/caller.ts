/**
 * Who is calling (spec §13.6.1): what the MCP layer knows about the token
 * and the request. The MCP tools build one per `tools/call`; the engine never
 * looks further up.
 */
export interface Caller {
  readonly clientId: string;
  readonly clientName: string;
  readonly tokenPrefix: string;
  /**
  The token's effective scopes (held and enabled).
  */
  readonly scopes: readonly string[];
  readonly requestId: string;
  readonly ip: string;
}
