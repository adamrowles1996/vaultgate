import {
  optionalNumber,
  optionalString,
  parseJsonArray,
  type Row,
  type SqlStore,
} from './sql-store.ts';

export interface AuthorizationCodeRecord {
  readonly codeHash: string;
  readonly clientId: string;
  readonly consentId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string | undefined;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly usedAt: number | undefined;
}

export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly code: AuthorizationCodeRecord }
  | { readonly kind: 'reused'; readonly code: AuthorizationCodeRecord }
  | { readonly kind: 'unknown' };

export interface AuthorizationCodesRepo {
  insert(record: AuthorizationCodeRecord): void;
  /**
   * OAUTH-21: marks the code used in one statement guarded by
   * `used_at IS NULL`, so two concurrent redemptions cannot both succeed.
   * Expiry is the caller's check; a claimed-but-expired code is still spent.
   */
  claim(codeHash: string, at: number): ClaimOutcome;
}

function toRecord(row: Row): AuthorizationCodeRecord {
  return {
    codeHash: String(row['code_hash']),
    clientId: String(row['client_id']),
    consentId: String(row['consent_id']),
    redirectUri: String(row['redirect_uri']),
    codeChallenge: String(row['code_challenge']),
    resource: optionalString(row['resource']),
    scopes: parseJsonArray(row['scopes']),
    expiresAt: Number(row['expires_at']),
    usedAt: optionalNumber(row['used_at']),
  };
}

export function createAuthorizationCodesRepo(store: SqlStore): AuthorizationCodesRepo {
  return {
    insert(record) {
      store.run(
        `INSERT INTO authorization_codes
           (code_hash, client_id, consent_id, redirect_uri, code_challenge, resource, scopes, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.codeHash,
        record.clientId,
        record.consentId,
        record.redirectUri,
        record.codeChallenge,
        record.resource ?? null,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.usedAt ?? null,
      );
    },
    claim(codeHash, at) {
      return store.transaction(() => {
        const changed = store.run(
          'UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
          at,
          codeHash,
        );
        const row = store.get('SELECT * FROM authorization_codes WHERE code_hash = ?', codeHash);
        if (row === undefined) {
          return { kind: 'unknown' };
        }
        return { kind: changed === 1 ? 'claimed' : 'reused', code: toRecord(row) };
      });
    },
  };
}
