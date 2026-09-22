/**
 * Tool-call audit events (MCP-13). An event names who did what and how it
 * went, never the arguments or the result: the only vault reference is the
 * item id (and the field name for `get_secret`).
 */
import type { Logger } from '../logger.ts';

type AuditOutcome = 'ok' | 'denied' | `error:${string}`;

export interface AuditEvent {
  /**
  ISO-8601.
  */
  readonly timestamp: string;
  readonly clientId: string;
  readonly clientName: string;
  /**
  Operator id.
  */
  readonly subject: string;
  /**
  First 12 hex of the token hash.
  */
  readonly tokenId: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  readonly itemId: string | null;
  /**
  Field name for `get_secret`; `null` for every other tool.
  */
  readonly field: string | null;
  readonly durationMs: number;
  readonly requestId: string;
  readonly sourceIp: string;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

/**
 * Writes each event as one structured log line. The store-backed sink that
 * satisfies MCP-15 retention lands with the storage layer; this one keeps the
 * trail in the log stream until then.
 */
export class LoggingAuditSink implements AuditSink {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  record(event: AuditEvent): void {
    this.#logger.info({ audit: event }, 'tool call');
  }
}
