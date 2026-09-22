import { type Parameters, run } from '../storage/query.ts';

import type { Logger } from '../logger.ts';
import type { AuditDetails, AuditEvent, AuditSink } from './event.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface StoreAuditSinkDependencies {
  readonly database: DatabaseSync;
  readonly logger: Logger;
  /**
  Milliseconds since the epoch, as `Date.now()`; stamps `audit_events.at`.
  */
  readonly now: () => number;
  /**
  A fresh UUID per row (the store's id convention).
  */
  readonly newId: () => string;
}

/**
 * Detail keys that name a credential are never persisted, whatever a caller
 * passes (ARCH-4). The list mirrors the logger's redaction backstop: a
 * password, secret, TOTP, cookie or credential anywhere in the key, or a key
 * ending in `token` or `code` (`csrfToken`, `recoveryCode`, …).
 */
const CREDENTIAL_KEY = /password|secret|totp|cookie|credential|token$|code$/i;

const INSERT =
  'INSERT INTO audit_events (id, at, category, action, outcome, operator_id, client_id, ' +
  'token_prefix, item_id, field, request_id, ip, duration_ms, details) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/**
The `details` column: the structured detail with every credential-named key removed, or NULL.
*/
function secretFreeDetails(details: AuditDetails | undefined): string | null {
  if (details === undefined) {
    return null;
  }
  const kept = Object.entries(details).filter(([key]) => !CREDENTIAL_KEY.test(key));
  return JSON.stringify(Object.fromEntries(kept));
}

function toRow(event: AuditEvent, id: string, at: number): Parameters {
  const optional = [
    event.operatorId,
    event.clientId,
    event.tokenPrefix,
    event.itemId,
    event.field,
    event.requestId,
    event.ip,
    event.durationMs,
  ].map((value) => value ?? null);
  return [
    id,
    at,
    event.category,
    event.action,
    event.outcome,
    ...optional,
    secretFreeDetails(event.details),
  ];
}

/**
 * Appends every event to `audit_events` as one INSERT inside the caller's
 * request. Only the schema's columns are written, so nothing outside the
 * event shape can reach the row. Rows are never updated or deleted here:
 * retention (STORE-6) is the store's maintenance task, nothing else touches
 * them (MCP-15). A failed write is logged and swallowed; the audited request
 * must not fail because its trail did.
 */
export class StoreAuditSink implements AuditSink {
  readonly #dependencies: StoreAuditSinkDependencies;

  constructor(dependencies: StoreAuditSinkDependencies) {
    this.#dependencies = dependencies;
  }

  record(event: AuditEvent): void {
    const { database, logger, now, newId } = this.#dependencies;
    try {
      run(database, INSERT, ...toRow(event, newId(), now()));
    } catch (error) {
      logger.error(
        { err: error, category: event.category, action: event.action },
        'audit event was not recorded',
      );
    }
  }
}
