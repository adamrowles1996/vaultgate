/**
 * Schema v2 (spec 07 §7.2, ID-3): the operator is identified by e-mail
 * address. `email` is nullable so a database created before this migration
 * still opens; such an operator signs in without an e-mail once and must set
 * one on the account page before anything else (ID-26). The unique index is
 * on `lower(email)` so the address is case-insensitive in the store as well
 * as at the form.
 *
 * `display_name` is deprecated. SQLite cannot relax its NOT NULL without
 * rebuilding a table that four others reference, so the column stays; new
 * rows write an empty string and nothing reads it.
 */
import type { Migration } from './types.ts';

const SQL = `
ALTER TABLE operators ADD COLUMN email TEXT;
CREATE UNIQUE INDEX idx_operators_email ON operators (lower(email));
`;

export const operatorEmail: Migration = { version: 2, name: 'operator-email', sql: SQL };
