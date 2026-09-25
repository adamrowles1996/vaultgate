import { describe, expect, it } from 'vitest';

import { TEST_CERTIFICATE_PEM } from '../../../test-support/test-certificate.ts';

import {
  portOf,
  sqlCredentialSchema,
  sqlDestinationSchema,
  sqlPolicySchema,
  sqlSchemas,
  statementTimeoutOf,
} from './schemas.ts';

const BASE = { engine: 'postgres', host: 'db.example.com', database: 'reporting' } as const;

function destination(
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof sqlDestinationSchema.parse> {
  return sqlDestinationSchema.parse({ ...BASE, ...overrides });
}

function policy(
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof sqlPolicySchema.parse> {
  return sqlPolicySchema.parse(overrides);
}

function problems(overrides: {
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
}): readonly string[] {
  return sqlSchemas.saveProblems({
    destination: destination(overrides.destination ?? {}),
    credential: sqlCredentialSchema.parse({}),
    policy: policy(overrides.policy ?? {}),
  });
}

describe('the sql target documents', () => {
  it('14.4 defaults the destination to require with no certificate authority', () => {
    expect(destination()).toStrictEqual({
      engine: 'postgres',
      host: 'db.example.com',
      database: 'reporting',
      tls: 'require',
      trust_server_certificate: false,
    });
  });

  it('14.4 defaults the port per engine and keeps an explicit one', () => {
    expect(portOf(destination())).toBe(5432);
    expect(portOf(destination({ engine: 'mssql' }))).toBe(1433);
    expect(portOf(destination({ port: 6543 }))).toBe(6543);
  });

  it('ACT-57 refuses trust_server_certificate: true, because there is no way to skip verification', () => {
    const parsed = sqlDestinationSchema.safeParse({ ...BASE, trust_server_certificate: true });
    expect(parsed.success).toBe(false);
  });

  it('14.4 defaults the credential mapping to the login username and the password field', () => {
    expect(sqlCredentialSchema.parse({})).toStrictEqual({
      username_from: 'login.username',
      password_field: 'password',
    });
  });

  it('14.4 defaults the policy to a read-only target of 500 rows', () => {
    expect(policy()).toMatchObject({
      operations: ['read'],
      max_rows: 500,
      write_classes: ['dml'],
      statement_allowlist: [],
      timeout_ms: 30_000,
    });
  });

  it('14.4 drops a policy field this build does not serve, rather than invalidating the target', () => {
    expect(policy({ schemas: ['reporting'] })).not.toHaveProperty('schemas');
  });

  it('14.4 caps max_rows at 10 000', () => {
    expect(sqlPolicySchema.safeParse({ max_rows: 10_001 }).success).toBe(false);
    expect(policy({ max_rows: 10_000 }).max_rows).toBe(10_000);
  });

  it('ACT-58 the statement timeout defaults to the call timeout and never outlives it', () => {
    expect(statementTimeoutOf(policy())).toBe(30_000);
    expect(statementTimeoutOf(policy({ statement_timeout_ms: 5000 }))).toBe(5000);
    expect(statementTimeoutOf(policy({ timeout_ms: 2000, statement_timeout_ms: 60_000 }))).toBe(
      2000,
    );
  });

  it('ACT-3 ACT-57 names the host and says whether the transport is encrypted', () => {
    expect(sqlSchemas.endpoints(destination())).toStrictEqual([
      { host: 'db.example.com', tls: true },
    ]);
    expect(sqlSchemas.endpoints(destination({ tls: 'disable' }))).toStrictEqual([
      { host: 'db.example.com', tls: false },
    ]);
  });

  it('ACT-4 names the username and password fields the mapping needs', () => {
    expect(
      sqlSchemas.credentialFields(sqlCredentialSchema.parse({ password_field: 'custom.db' })),
    ).toStrictEqual([
      { name: 'login.username', selector: 'login.username', role: 'username' },
      { name: 'custom.db', selector: 'custom.db', role: 'secret' },
    ]);
  });

  it('ACT-43 summarises the destination as host, port and database, never a credential', () => {
    expect(sqlSchemas.summariseDestination(destination())).toBe('db.example.com:5432/reporting');
    expect(sqlSchemas.summariseDestination(destination({ engine: 'mssql', port: 1433 }))).toBe(
      'db.example.com:1433/reporting',
    );
  });
});

describe('the sql save-time checks', () => {
  it('14.4 accepts a read-only target with no problems', () => {
    expect(problems({})).toStrictEqual([]);
  });

  it('ACT-57 verify-full needs the certificate authority it verifies against', () => {
    expect(problems({ destination: { tls: 'verify-full' } })).toStrictEqual([
      'destination.ca_pem: the verify-full mode needs the certificate authority to verify against',
    ]);
    expect(
      problems({ destination: { tls: 'verify-full', ca_pem: TEST_CERTIFICATE_PEM } }),
    ).toStrictEqual([]);
  });

  it('ACT-57 refuses a certificate authority that is not a PEM certificate, as a one-line paste is', () => {
    const refusal = [
      'destination.ca_pem: is not a PEM certificate; paste it with its line breaks, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----',
    ];
    const oneLine = TEST_CERTIFICATE_PEM.replaceAll('\n', '');
    const lines = TEST_CERTIFICATE_PEM.split('\n');
    const truncated = [...lines.slice(0, 2), ...lines.slice(3)].join('\n');
    for (const ca_pem of ['-----BEGIN', oneLine, truncated]) {
      expect(problems({ destination: { tls: 'verify-full', ca_pem } })).toStrictEqual(refusal);
    }
  });

  it('ACT-57 a certificate authority without verify-full is refused rather than ignored', () => {
    expect(problems({ destination: { ca_pem: '-----BEGIN' } })).toStrictEqual([
      'destination.ca_pem: applies to the verify-full mode only',
    ]);
  });

  /**
   * The live test found an `mssql` target named by address accepted at save
   * time and failing at call time as `connection_failed`, which reads as an
   * unreachable server. Tedious cannot verify a certificate against an
   * address at all, so the refusal belongs where the operator can act on it.
   */
  it('ACT-57 a SQL Server destination named by address cannot be verified and is refused', () => {
    expect(problems({ destination: { engine: 'mssql', host: '192.0.2.40' } })).toStrictEqual([
      'destination.host: SQL Server cannot verify a certificate against an address; name the ' +
        'host as the certificate names it, or use tls "disable" on an internal target',
    ]);
  });

  it('ACT-57 the same SQL Server destination is fine on plain transport', () => {
    expect(
      problems({ destination: { engine: 'mssql', host: '192.0.2.40', tls: 'disable' } }),
    ).toStrictEqual([]);
  });

  it('ACT-57 PostgreSQL verifies an address against the certificate IP names, so it is accepted', () => {
    expect(problems({ destination: { host: '192.0.2.40' } })).toStrictEqual([]);
    expect(problems({ destination: { engine: 'mssql', host: 'db.example.com' } })).toStrictEqual(
      [],
    );
  });

  it('14.4 accepts a target that allows read and write', () => {
    expect(problems({ policy: { operations: ['read', 'write'] } })).toStrictEqual([]);
  });

  it('14.4 a target that allows write must allow read as well', () => {
    expect(problems({ policy: { operations: ['write'] } })).toStrictEqual([
      'policy.operations: a target that allows write must allow read as well',
    ]);
  });
});
