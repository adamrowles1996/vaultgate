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
  readonly operatorId?: string;
  readonly clientId?: string;
  /**
  The recognisable prefix of a credential, never the credential.
  */
  readonly tokenPrefix?: string;
  readonly requestId?: string;
  readonly ip?: string;
  /**
  Secret-free structured detail.
  */
  readonly details?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}
