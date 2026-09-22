import { z } from 'zod';

import { get, run } from '../../storage/query.ts';

import { jsonStringArray, optionalText, optionalTimestamp, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const tokenRow = z.object({
  id: z.string(),
  token_hash: z.string(),
  kind: z.enum(['access', 'refresh']),
  family_id: z.string(),
  parent_id: optionalText,
  replaced_by_id: optionalText,
  client_id: z.string(),
  consent_id: z.string(),
  scopes: jsonStringArray,
  resource: z.string(),
  issued_at: timestamp,
  expires_at: timestamp,
  revoked_at: optionalTimestamp,
  last_used_at: optionalTimestamp,
});

type TokenKind = z.output<typeof tokenRow>['kind'];

export interface TokenRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly kind: TokenKind;
  /**
  Every token descending from one authorization code shares a family.
  */
  readonly familyId: string;
  readonly parentId: string | undefined;
  readonly replacedById: string | undefined;
  readonly clientId: string;
  readonly consentId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | undefined;
  readonly lastUsedAt: number | undefined;
}

export interface TokensRepo {
  insert(record: TokenRecord): void;
  findByHash(tokenHash: string): TokenRecord | undefined;
  /**
  OAUTH-25: single use; false when the token was already rotated.
  */
  markReplaced(id: string, replacedById: string): boolean;
  revokeById(id: string, at: number): number;
  revokeFamily(familyId: string, at: number): number;
  revokeByConsent(consentId: string, at: number): number;
  touchLastUsed(id: string, at: number): void;
}

function toRecord(row: z.output<typeof tokenRow>): TokenRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    kind: row.kind,
    familyId: row.family_id,
    parentId: row.parent_id,
    replacedById: row.replaced_by_id,
    clientId: row.client_id,
    consentId: row.consent_id,
    scopes: row.scopes,
    resource: row.resource,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

const REVOKE_UNREVOKED = 'UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND ';

export function createTokensRepo(database: DatabaseSync): TokensRepo {
  return {
    insert(record) {
      run(
        database,
        `INSERT INTO tokens
            (id, token_hash, kind, family_id, parent_id, replaced_by_id, client_id, consent_id,
            scopes, resource, issued_at, expires_at, revoked_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.tokenHash,
        record.kind,
        record.familyId,
        record.parentId ?? null,
        record.replacedById ?? null,
        record.clientId,
        record.consentId,
        JSON.stringify(record.scopes),
        record.resource,
        record.issuedAt,
        record.expiresAt,
        record.revokedAt ?? null,
        record.lastUsedAt ?? null,
      );
    },
    findByHash(tokenHash) {
      const row = get(database, 'SELECT * FROM tokens WHERE token_hash = ?', tokenRow, tokenHash);
      return row === undefined ? undefined : toRecord(row);
    },
    markReplaced(id, replacedById) {
      return (
        run(
          database,
          'UPDATE tokens SET replaced_by_id = ? WHERE id = ? AND replaced_by_id IS NULL',
          replacedById,
          id,
        ) === 1
      );
    },
    revokeById(id, at) {
      return run(database, `${REVOKE_UNREVOKED}id = ?`, at, id);
    },
    revokeFamily(familyId, at) {
      return run(database, `${REVOKE_UNREVOKED}family_id = ?`, at, familyId);
    },
    revokeByConsent(consentId, at) {
      return run(database, `${REVOKE_UNREVOKED}consent_id = ?`, at, consentId);
    },
    touchLastUsed(id, at) {
      run(database, 'UPDATE tokens SET last_used_at = ? WHERE id = ?', at, id);
    },
  };
}
