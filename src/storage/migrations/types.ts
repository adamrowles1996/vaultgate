/**
 * One forward-only schema migration. `sql` is applied verbatim inside a
 * single transaction and its SHA-256 is recorded in `schema_migrations`, so
 * an applied migration must never be edited: add a new version instead.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
