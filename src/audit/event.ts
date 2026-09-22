/**
 * The one audit event shape every feature records (MCP-13, MCP-14): who did
 * what and how it went, never an argument, a result or a credential. The
 * only vault reference is the item id (and the field name for `get_secret`).
 * The store-backed sink assigns the row id and the timestamp as it appends.
 */
type AuditCategory = 'identity' | 'oauth' | 'mcp';

/**
`error:<code>` carries a tool's failure code (MCP-13); `denied` is a refused request.
*/
type AuditOutcome = 'ok' | 'failure' | 'denied' | `error:${string}`;

type AuditDetailValue = string | number | boolean | readonly string[];

/**
Secret-free structured detail; the sink additionally drops any key that names a credential.
*/
export type AuditDetails = Readonly<Record<string, AuditDetailValue>>;

export interface AuditEvent {
  readonly category: AuditCategory;
  /**
  The tool name for `mcp`; a dotted verb such as `login.succeeded` for the browser features.
  */
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly operatorId?: string | undefined;
  readonly clientId?: string | undefined;
  /**
  First 12 hex of the token hash; never the token.
  */
  readonly tokenPrefix?: string | undefined;
  readonly itemId?: string | undefined;
  /**
  Field name for `get_secret`; absent for every other action.
  */
  readonly field?: string | undefined;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly details?: AuditDetails | undefined;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

/**
An event as the store holds it: the recorded shape plus its row id and timestamp.
*/
export interface StoredAuditEvent extends AuditEvent {
  readonly id: string;
  /**
  Milliseconds since the epoch.
  */
  readonly at: number;
}
