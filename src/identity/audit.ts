/**
 * Identity audit events (login, logout, denied requests, account changes).
 * The writer that persists them lands with `src/audit/`; identity only
 * emits through this sink so the module stays independent of the store's
 * audit table (secret-free by construction: no token, code or password).
 */
export interface IdentityAuditEvent {
  readonly category: 'identity';
  readonly action: string;
  readonly outcome: 'success' | 'failure' | 'denied';
  readonly operatorId?: string | undefined;
  readonly ip?: string | undefined;
  readonly requestId?: string | undefined;
  readonly details?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export type AuditSink = (event: IdentityAuditEvent) => void;
