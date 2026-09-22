/**
 * The authorization events MCP-14 requires, as a narrowing of the one shared
 * `AuditEvent` (src/audit/event.ts): the category is fixed and the action is
 * one of the names below, so a call site cannot mistype either. The sink is
 * the shared store-backed one, wired at composition time.
 */
import type { AuditEvent } from '../audit/event.ts';

export type OAuthAuditAction =
  | 'consent_granted'
  | 'consent_denied'
  | 'consent_revoked'
  | 'token_issued'
  | 'token_refreshed'
  | 'token_revoked'
  | 'client_registered';

interface OAuthAuditEvent extends AuditEvent {
  readonly category: 'oauth';
  readonly action: OAuthAuditAction;
}

/**
What the authorization server records through; any `AuditSink` satisfies it.
*/
export interface OAuthAuditSink {
  record(event: OAuthAuditEvent): void;
}
