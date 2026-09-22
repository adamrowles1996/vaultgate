/**
 * The authorization events MCP-14 requires. The sink implementation lives in
 * `src/audit/`; this module only depends on the shape.
 */
export type OAuthAuditAction =
  | 'consent_granted'
  | 'consent_denied'
  | 'consent_revoked'
  | 'token_issued'
  | 'token_refreshed'
  | 'token_revoked'
  | 'client_registered';

export interface AuditEvent {
  readonly category: 'oauth';
  readonly action: OAuthAuditAction;
  readonly outcome: 'success' | 'failure';
  readonly operatorId?: string | undefined;
  readonly clientId?: string | undefined;
  /**
  The recognisable prefix of a credential, never the credential.
  */
  readonly tokenPrefix?: string | undefined;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  /**
  Secret-free structured detail.
  */
  readonly details?:
    Readonly<Record<string, string | number | boolean | readonly string[]>> | undefined;
}

export interface AuditLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

/**
 * Writes each event as one structured log line; the store-backed sink that
 * satisfies MCP-15 retention replaces it at composition time when it lands.
 */
export function createLoggingAuditSink(logger: AuditLogger): AuditSink {
  return {
    record(event) {
      logger.info({ audit: event }, 'authorization event');
    },
  };
}
