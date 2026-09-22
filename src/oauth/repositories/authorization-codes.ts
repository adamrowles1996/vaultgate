import { z } from 'zod';

import { get, run, transaction } from '../../storage/query.ts';

import { jsonStringArray, optionalTimestamp, timestamp } from './rows.ts';

import type { DatabaseSync } from 'node:sqlite';

const codeRow = z.object({
  code_hash: z.string(),
  client_id: z.string(),
  consent_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  resource: z.string(),
  scopes: jsonStringArray,
  expires_at: timestamp,
  used_at: optionalTimestamp,
});

export interface AuthorizationCodeRecord {
  readonly codeHash: string;
  readonly clientId: string;
  readonly consentId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly usedAt: number | undefined;
}

type ClaimOutcome =
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

function toRecord(row: z.output<typeof codeRow>): AuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    consentId: row.consent_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export function createAuthorizationCodesRepo(database: DatabaseSync): AuthorizationCodesRepo {
  return {
    insert(record) {
      run(
        database,
        `INSERT INTO authorization_codes
            (code_hash, client_id, consent_id, redirect_uri, code_challenge, resource, scopes,
            expires_at, used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.codeHash,
        record.clientId,
        record.consentId,
        record.redirectUri,
        record.codeChallenge,
        record.resource,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.usedAt ?? null,
      );
    },
    claim(codeHash, at) {
      return transaction(database, (): ClaimOutcome => {
        const changed = run(
          database,
          'UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
          at,
          codeHash,
        );
        const row = get(
          database,
          'SELECT * FROM authorization_codes WHERE code_hash = ?',
          codeRow,
          codeHash,
        );
        if (row === undefined) {
          return { kind: 'unknown' };
        }
        return { kind: changed === 1 ? 'claimed' : 'reused', code: toRecord(row) };
      });
    },
  };
}
