/**
 * A PostgreSQL client double that models run-time settings the way the
 * server documents them (`set_config`, §9.28.1 of the PostgreSQL manual): a
 * setting made with `is_local = true` lasts until the current transaction
 * ends, by `COMMIT` or `ROLLBACK`, and outside a transaction it has no
 * effect; a custom placeholder such as `app.actor_id` reads back as an empty
 * string once it has been set in the session, and as `NULL` (with
 * `missing_ok`) before. One double stands for one connection, so a test can
 * reuse it across calls the way a pool reuses a connection.
 */
import type { PostgresClient } from '../actions/connectors/sql/postgres/session.ts';

const TEXT_OID = 25;

/**
The statement a test runs to read both settings back, as the agent would.
*/
export const READ_TAG =
  "SELECT current_setting('application_name') AS app, current_setting('app.actor_id', true) AS actor";

/**
A statement this double fails inside the transaction, as a constraint or a cast would.
*/
export const FAILING_STATEMENT = 'SELECT 1 / 0';

export interface SettingsClient extends PostgresClient {
  readonly texts: string[];
  /**
  The two settings as a statement outside any call would see them on this connection.
  */
  readonly settings: () => { readonly app: string | null; readonly actor: string | null };
}

interface Connection {
  readonly session: Map<string, string>;
  /**
  The open transaction's local settings, under the one key `open`; empty outside a transaction.
  */
  readonly transaction: Map<'open', Map<string, string>>;
  readonly placeholders: Set<string>;
}

function read(connection: Connection, name: string): string | null {
  const value = connection.transaction.get('open')?.get(name) ?? connection.session.get(name);
  if (value !== undefined) {
    return value;
  }
  return connection.placeholders.has(name) ? '' : null;
}

function setLocal(connection: Connection, values: readonly unknown[] | undefined): void {
  const [tag] = values ?? [];
  const local = connection.transaction.get('open');
  if (typeof tag !== 'string' || local === undefined) {
    return;
  }
  local.set('application_name', tag);
  local.set('app.actor_id', tag);
  connection.placeholders.add('app.actor_id');
}

const EMPTY = { fields: [], rows: [], rowCount: null };

function answer(
  connection: Connection,
  text: string,
  values: readonly unknown[] | undefined,
): ReturnType<PostgresClient['query']> {
  if (text.startsWith('BEGIN')) {
    connection.transaction.set('open', new Map());
  } else if (text === 'COMMIT' || text === 'ROLLBACK') {
    connection.transaction.delete('open');
  } else if (text.includes('set_config(')) {
    setLocal(connection, values);
  } else if (text === FAILING_STATEMENT) {
    return Promise.reject(Object.assign(new Error('division by zero'), { code: '22012' }));
  } else if (text.startsWith('SELECT oid')) {
    return Promise.resolve({ fields: [], rows: [[TEXT_OID, 'text']], rowCount: 1 });
  } else if (text === READ_TAG) {
    const fields = [
      { name: 'app', dataTypeID: TEXT_OID },
      { name: 'actor', dataTypeID: TEXT_OID },
    ];
    const row = [read(connection, 'application_name'), read(connection, 'app.actor_id')];
    return Promise.resolve({ fields, rows: [row], rowCount: 1 });
  }
  return Promise.resolve(EMPTY);
}

/**
One connection whose `application_name` is `vaultgate`, as `configOf` connects it.
*/
export function settingsPostgresClient(): SettingsClient {
  const connection: Connection = {
    session: new Map([['application_name', 'vaultgate']]),
    transaction: new Map(),
    placeholders: new Set(),
  };
  const texts: string[] = [];
  return {
    texts,
    settings: () => ({
      app: read(connection, 'application_name'),
      actor: read(connection, 'app.actor_id'),
    }),
    connect: () => Promise.resolve(undefined),
    query(query) {
      texts.push(query.text);
      return answer(connection, query.text, query.values);
    },
    end: () => Promise.resolve(),
  };
}
