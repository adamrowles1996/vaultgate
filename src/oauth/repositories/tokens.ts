import {
  optionalNumber,
  optionalString,
  parseJsonArray,
  type Row,
  type SqlStore,
} from './sql-store.ts';

export type TokenKind = 'access' | 'refresh';

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
  readonly resource: string | undefined;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | undefined;
  readonly lastUsedAt: number | undefined;
}

export interface TokensRepo {
  insert(record: TokenRecord): void;
  findByHash(tokenHash: string): TokenRecord | undefined;
  /**
  OAUTH-25: single use; returns false when the token was already rotated.
  */
  markReplaced(id: string, replacedById: string): boolean;
  revokeById(id: string, at: number): number;
  revokeFamily(familyId: string, at: number): number;
  revokeByConsent(consentId: string, at: number): number;
  touchLastUsed(id: string, at: number): void;
}

function toRecord(row: Row): TokenRecord {
  return {
    id: String(row['id']),
    tokenHash: String(row['token_hash']),
    kind: String(row['kind']) as TokenKind,
    familyId: String(row['family_id']),
    parentId: optionalString(row['parent_id']),
    replacedById: optionalString(row['replaced_by_id']),
    clientId: String(row['client_id']),
    consentId: String(row['consent_id']),
    scopes: parseJsonArray(row['scopes']),
    resource: optionalString(row['resource']),
    issuedAt: Number(row['issued_at']),
    expiresAt: Number(row['expires_at']),
    revokedAt: optionalNumber(row['revoked_at']),
    lastUsedAt: optionalNumber(row['last_used_at']),
  };
}

const REVOKE_UNREVOKED = 'UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND ';

export function createTokensRepo(store: SqlStore): TokensRepo {
  return {
    insert(record) {
      store.run(
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
        record.resource ?? null,
        record.issuedAt,
        record.expiresAt,
        record.revokedAt ?? null,
        record.lastUsedAt ?? null,
      );
    },
    findByHash(tokenHash) {
      const row = store.get('SELECT * FROM tokens WHERE token_hash = ?', tokenHash);
      return row === undefined ? undefined : toRecord(row);
    },
    markReplaced(id, replacedById) {
      return (
        store.run(
          'UPDATE tokens SET replaced_by_id = ? WHERE id = ? AND replaced_by_id IS NULL',
          replacedById,
          id,
        ) === 1
      );
    },
    revokeById(id, at) {
      return store.run(`${REVOKE_UNREVOKED}id = ?`, at, id);
    },
    revokeFamily(familyId, at) {
      return store.run(`${REVOKE_UNREVOKED}family_id = ?`, at, familyId);
    },
    revokeByConsent(consentId, at) {
      return store.run(`${REVOKE_UNREVOKED}consent_id = ?`, at, consentId);
    },
    touchLastUsed(id, at) {
      store.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', at, id);
    },
  };
}
