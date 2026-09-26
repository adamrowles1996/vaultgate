/**
 * The `sql` connector's form (spec §14.4): one descriptor per field of its
 * three documents, in the order the operator reads them. The fields only
 * `sql_execute` consults (`write_classes`, `statement_allowlist`) are shown
 * with help that says so.
 */
import { SQL_ENGINES } from '../connectors/sql/schemas.ts';

import type { FieldDescriptor } from './descriptors.ts';

const MAX_ROWS = 10_000;
const DEFAULT_ROWS = 500;

const SELECTOR_HELP =
  'A vault field: password, notes, custom.<name> for a hidden custom field, or any other ' +
  'get_secret selector.';

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'engine',
    label: 'Engine',
    kind: 'select',
    options: SQL_ENGINES.map((engine) => ({ value: engine, label: engine })),
    fallback: 'postgres',
    help: 'The dialect the statements are written in and the placeholders they use.',
  },
  {
    document: 'destination',
    name: 'host',
    label: 'Host',
    kind: 'text',
    address: 'host',
    required: true,
    help: 'Resolved once per call; the connection goes to that address and the name is kept for TLS.',
  },
  {
    document: 'destination',
    name: 'port',
    label: 'Port',
    kind: 'number',
    min: 1,
    max: 65_535,
    fallback: 5432,
    help: 'Default 5432 for PostgreSQL and 1433 for SQL Server.',
  },
  {
    document: 'destination',
    name: 'database',
    label: 'Database',
    kind: 'text',
    required: true,
  },
  {
    document: 'destination',
    name: 'tls',
    label: 'Transport security',
    kind: 'select',
    options: [
      { value: 'require', label: 'require' },
      { value: 'verify-full', label: 'verify-full' },
      { value: 'disable', label: 'disable' },
    ],
    fallback: 'require',
    help:
      'require verifies the certificate against the system store; verify-full verifies it ' +
      'against the certificate authority below. There is no way to skip verification. disable ' +
      'is plain transport and needs an internal connection.',
  },
  {
    document: 'destination',
    name: 'ca_pem',
    label: 'Certificate authority (PEM)',
    kind: 'text',
    multiline: true,
    when: { field: 'tls', values: ['verify-full'] },
    help: 'The PEM the server certificate must chain to. Used by the verify-full mode.',
  },
];

const credential: readonly FieldDescriptor[] = [
  {
    document: 'credential',
    name: 'username_from',
    label: 'Login name field',
    kind: 'text',
    picker: { role: 'username', fallback: 'login.username' },
    help: `login.username unless another field holds it. ${SELECTOR_HELP}`,
  },
  {
    document: 'credential',
    name: 'password_field',
    label: 'Password field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'password' },
    help: `password unless another field holds it. ${SELECTOR_HELP}`,
  },
];

const policy: readonly FieldDescriptor[] = [
  {
    document: 'policy',
    name: 'operations',
    label: 'Allowed operations',
    kind: 'set',
    options: ['read', 'write'],
    fallback: ['read'],
    help:
      'read runs sql_query; write also runs sql_execute, and a connection that allows write must ' +
      'allow read as well.',
  },
  {
    document: 'policy',
    name: 'max_rows',
    label: 'Maximum rows',
    kind: 'number',
    min: 1,
    max: MAX_ROWS,
    fallback: DEFAULT_ROWS,
    help: 'Default 500, at most 10 000; further rows are dropped and the result says truncated.',
  },
  {
    document: 'policy',
    name: 'statement_timeout_ms',
    label: 'Statement timeout (ms)',
    kind: 'number',
    min: 1000,
    max: 300_000,
    fallback: 30_000,
    help: 'The server cancels a statement that runs longer. Defaults to the call timeout below.',
  },
  {
    document: 'policy',
    name: 'write_classes',
    label: 'Allowed write classes',
    kind: 'set',
    options: ['dml', 'ddl'],
    fallback: ['dml'],
    help: 'dml is INSERT, UPDATE, DELETE and MERGE; ddl is CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE and DENY. Read by sql_execute only.',
  },
  {
    document: 'policy',
    name: 'statement_allowlist',
    label: 'Allowed statements',
    kind: 'lines',
    fallback: [],
    help:
      'One pattern per line, matched against the whole statement as the agent wrote it: * ' +
      'matches within one line, and matching is anchored at both ends. Empty means no ' +
      'statement restriction. Read by sql_execute only.',
  },
];

export const sqlForm = {
  kind: 'sql',
  fields: [...destination, ...credential, ...policy],
} as const;
