/**
 * The `sql` connector's target documents (spec §14.4). The schemas are the
 * static half every build carries so the account page can validate and edit
 * targets; the runtime is `./index.ts`.
 */
import { isIP } from 'node:net';

import { z } from 'zod';

import { commonPolicySchema } from '../../policy.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const SQL_ENGINES = ['mssql', 'postgres'] as const;

export const DEFAULT_PORTS: Readonly<Record<(typeof SQL_ENGINES)[number], number>> = {
  mssql: 1433,
  postgres: 5432,
};

const MAX_ROWS = 10_000;
const DEFAULT_ROWS = 500;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PORT = 65_535;

export const sqlDestinationSchema = z.strictObject({
  engine: z.enum(SQL_ENGINES),
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).optional(),
  database: z.string().min(1),
  /**
  ACT-57: `require` verifies against the system store, `verify-full` against `ca_pem`; there is no
  way to skip verification. `disable` is plain transport and needs an internal target (ACT-3).
  */
  tls: z.enum(['require', 'verify-full', 'disable']).default('require'),
  ca_pem: z.string().min(1).optional(),
  /**
  §14.4 names the SQL Server option; ACT-57 leaves no room for it to be anything but `false`.
  */
  trust_server_certificate: z.literal(false).default(false),
});

const fieldSelectorSchema = z.string().min(1);

export const sqlCredentialSchema = z.strictObject({
  username_from: fieldSelectorSchema.default('login.username'),
  password_field: fieldSelectorSchema.default('password'),
});

export const sqlPolicySchema = commonPolicySchema.extend({
  operations: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .default(['read']),
  max_rows: z.number().int().min(1).max(MAX_ROWS).default(DEFAULT_ROWS),
  statement_timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
  write_classes: z
    .array(z.enum(['dml', 'ddl']))
    .min(1)
    .default(['dml']),
  statement_allowlist: z.array(z.string().min(1)).default([]),
});

export type SqlDestination = z.output<typeof sqlDestinationSchema>;
export type SqlCredential = z.output<typeof sqlCredentialSchema>;
export type SqlPolicy = z.output<typeof sqlPolicySchema>;

export function portOf(destination: SqlDestination): number {
  return destination.port ?? DEFAULT_PORTS[destination.engine];
}

/**
ACT-58: the statement timeout the engine enforces, `timeout_ms` unless the policy narrows it.
*/
export function statementTimeoutOf(policy: SqlPolicy): number {
  return Math.min(policy.statement_timeout_ms ?? policy.timeout_ms, policy.timeout_ms);
}

function endpoints(destination: SqlDestination): readonly Endpoint[] {
  return [{ host: destination.host, tls: destination.tls !== 'disable' }];
}

function credentialFields(credential: SqlCredential): readonly CredentialField[] {
  return [
    { name: credential.username_from, selector: credential.username_from, role: 'username' },
    { name: credential.password_field, selector: credential.password_field, role: 'secret' },
  ];
}

function tlsProblems(destination: SqlDestination): readonly string[] {
  if (destination.tls === 'verify-full' && destination.ca_pem === undefined) {
    return [
      'destination.ca_pem: the verify-full mode needs the certificate authority to verify against',
    ];
  }
  return destination.tls === 'verify-full' || destination.ca_pem === undefined
    ? []
    : ['destination.ca_pem: applies to the verify-full mode only'];
}

/**
 * ACT-57: a TLS destination named by address is verified against the
 * certificate's IP subject-alternative names, which PostgreSQL's driver
 * allows and SQL Server's does not: Tedious puts the server name straight
 * into `tls.connect`, which refuses an IP literal as SNI, and its in-band
 * TLS path hands the socket no host to verify an address against instead.
 * There is no configuration that makes it work, so the target is refused at
 * save time rather than at the first call, where it looks like an unreachable
 * server.
 */
function addressProblems(destination: SqlDestination): readonly string[] {
  return destination.engine === 'mssql' && destination.tls !== 'disable' && isIP(destination.host)
    ? [
        'destination.host: SQL Server cannot verify a certificate against an address; name the ' +
          'host as the certificate names it, or use tls "disable" on an internal target',
      ]
    : [];
}

/**
A write target is a read target too: `sql_execute` is judged on the same classification as `sql_query`.
*/
function operationProblems(policy: SqlPolicy): readonly string[] {
  return policy.operations.includes('write') && !policy.operations.includes('read')
    ? ['policy.operations: a target that allows write must allow read as well']
    : [];
}

export const sqlSchemas: ConnectorSchemas<SqlDestination, SqlCredential, SqlPolicy> = {
  kind: 'sql',
  destinationSchema: sqlDestinationSchema,
  credentialSchema: sqlCredentialSchema,
  policySchema: sqlPolicySchema,
  endpoints,
  credentialFields,
  saveProblems({ destination, policy }) {
    return [
      ...tlsProblems(destination),
      ...addressProblems(destination),
      ...operationProblems(policy),
    ];
  },
  summariseDestination(destination) {
    return `${destination.host}:${portOf(destination)}/${destination.database}`;
  },
};
