/**
 * The operator-side events of ACT-7 as a narrowing of the shared
 * `AuditEvent`: category `actions`, one of the actions below, the target
 * name and connector in `details`, the operator id, and for updates the
 * changed field names (never values; the credential document is reported as
 * `credential`). The export shows `actions` and the action side by side,
 * which is the `actions.<action>` name of the specification.
 */
import type { AuditEvent } from '../audit/event.ts';

export type ActionsAuditAction =
  | 'target_created'
  | 'target_updated'
  | 'target_deleted'
  | 'target_enabled'
  | 'target_disabled'
  | 'grant_added'
  | 'grant_removed'
  | 'sessions_closed'
  /**
  ACT-83: a credential the layer rotated in the vault; the item and field, never the value.
  */
  | 'credential_rotated';

export interface ActionsAuditEvent extends AuditEvent {
  readonly category: 'actions';
  readonly action: ActionsAuditAction;
}

export interface ActionsAuditSink {
  record(event: ActionsAuditEvent): void;
}
