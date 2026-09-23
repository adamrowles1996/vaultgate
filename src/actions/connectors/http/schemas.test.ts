import { describe, expect, it } from 'vitest';

import {
  type HttpCredential,
  httpCredentialSchema,
  type HttpDestination,
  httpDestinationSchema,
  type HttpPolicy,
  httpPolicySchema,
  httpSchemas,
} from './schemas.ts';

import type { TargetDocuments } from '../connector.ts';

type Documents = TargetDocuments<HttpDestination, HttpCredential, HttpPolicy>;

const GRAPH: HttpCredential = {
  mode: 'graph',
  tenant_id: 'tenant',
  client_id: 'client',
  grant: 'client_credentials',
  scope: 'https://graph.microsoft.com/.default',
  secret_field: 'custom.client-secret',
};

function documents(overrides: Partial<Documents> = {}): Documents {
  return {
    destination: { base_url: 'https://api.example.com/v1' },
    credential: { mode: 'bearer', field: 'password' },
    policy: httpPolicySchema.parse({ allowed_paths: ['/**'] }),
    ...overrides,
  };
}

describe('http destination', () => {
  it('14.2 accepts an https origin with an optional path prefix and refuses queries, fragments, credentials and other schemes', () => {
    expect(httpDestinationSchema.parse({ base_url: 'https://api.example.com/v1' })).toStrictEqual({
      base_url: 'https://api.example.com/v1',
    });
    expect(httpDestinationSchema.parse({ base_url: 'http://intranet.local' }).base_url).toBe(
      'http://intranet.local',
    );
    const refused = [
      'not a url',
      'ftp://x.example.com',
      'https://x.example.com/?a=1',
      'https://x.example.com/#f',
      'https://x.example.com/?',
      'https://x.example.com/#',
      'https://user:pw@x.example.com/',
      'https://:pw@x.example.com/',
    ];
    expect(
      refused.map(
        (base_url) => httpDestinationSchema.safeParse({ base_url }).error?.issues[0]?.message,
      ),
    ).toStrictEqual([
      'must be an absolute URL',
      'must be an https:// (or, on an internal target, http://) URL',
      'must not carry a query string or fragment',
      'must not carry a query string or fragment',
      'must not carry a query string or fragment',
      'must not carry a query string or fragment',
      'must not carry credentials',
      'must not carry credentials',
    ]);
    expect(
      httpDestinationSchema.safeParse({ base_url: 'https://x.example.com', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('http credential', () => {
  it('14.2 ACT-79 ACT-81 accepts the five modes with their fields and defaults', () => {
    expect(httpCredentialSchema.parse({ mode: 'bearer', field: 'password' })).toStrictEqual({
      mode: 'bearer',
      field: 'password',
    });
    expect(httpCredentialSchema.parse({ mode: 'basic', field: 'password' })).toStrictEqual({
      mode: 'basic',
      field: 'password',
      username_from: 'login.username',
    });
    expect(
      httpCredentialSchema.parse({
        mode: 'header',
        field: 'custom.API key',
        name: 'X-Api-Key',
        prefix: 'Token ',
      }),
    ).toStrictEqual({
      mode: 'header',
      field: 'custom.API key',
      name: 'x-api-key',
      prefix: 'Token ',
    });
    expect(
      httpCredentialSchema.parse({ mode: 'query', field: 'password', name: 'key' }),
    ).toStrictEqual({
      mode: 'query',
      field: 'password',
      name: 'key',
    });
    expect(
      httpCredentialSchema.parse({
        mode: 'graph',
        tenant_id: 'tenant',
        client_id: 'client',
        grant: 'client_credentials',
        secret_field: 'custom.client-secret',
      }),
    ).toStrictEqual(GRAPH);
    expect(
      httpCredentialSchema.safeParse({ ...GRAPH, grant: 'refresh_token' }).error?.issues[0]
        ?.message,
    ).toBe('refresh_token_field is required for the refresh_token grant');
    expect(
      httpCredentialSchema.safeParse({
        ...GRAPH,
        grant: 'refresh_token',
        refresh_token_field: 'custom.refresh-token',
      }).success,
    ).toBe(true);
    expect(
      httpCredentialSchema.safeParse({ mode: 'header', field: 'password', name: 'bad header' })
        .success,
    ).toBe(false);
    expect(httpCredentialSchema.safeParse({ mode: 'cookie', field: 'password' }).success).toBe(
      false,
    );
  });
});

describe('http policy', () => {
  it('14.2 applies the defaults of the table on top of the common fields', () => {
    expect(httpPolicySchema.parse({ allowed_paths: ['/**'] })).toStrictEqual({
      timeout_ms: 30_000,
      max_output_bytes: 262_144,
      rate_limit_per_minute: 60,
      confirm_writes: false,
      allowed_methods: ['GET', 'HEAD'],
      allowed_paths: ['/**'],
      allowed_request_headers: ['accept', 'content-type', 'if-none-match'],
      response_headers: ['content-type', 'content-length', 'location', 'retry-after'],
      max_body_bytes: 262_144,
      follow_redirects: false,
      allow_query_credentials: false,
    });
    expect(
      httpPolicySchema.parse({
        allowed_paths: ['/a'],
        allowed_request_headers: ['X-Trace'],
        max_body_bytes: 4 * 1024 * 1024,
      }),
    ).toMatchObject({ allowed_request_headers: ['x-trace'], max_body_bytes: 4_194_304 });
    const refused = [
      {},
      { allowed_paths: [] },
      { allowed_paths: ['/'], allowed_methods: [] },
      { allowed_paths: ['/'], allowed_methods: ['TRACE'] },
      { allowed_paths: ['/'], max_body_bytes: 4 * 1024 * 1024 + 1 },
    ];
    expect(refused.map((policy) => httpPolicySchema.safeParse(policy).success)).toStrictEqual(
      refused.map(() => false),
    );
  });
});

describe('httpSchemas', () => {
  it('ACT-3 ACT-57 names the one host of base_url and whether it is reached over TLS', () => {
    expect(httpSchemas.endpoints({ base_url: 'https://api.example.com:8443/v1' })).toStrictEqual([
      { host: 'api.example.com', tls: true },
    ]);
    expect(httpSchemas.endpoints({ base_url: 'http://[::1]:8080' })).toStrictEqual([
      { host: '[::1]', tls: false },
    ]);
  });

  it('ACT-4 lists the vault fields each credential mode needs', () => {
    expect(httpSchemas.credentialFields({ mode: 'bearer', field: 'password' })).toStrictEqual([
      { name: 'password', selector: 'password', role: 'secret' },
    ]);
    expect(
      httpSchemas.credentialFields({
        mode: 'basic',
        field: 'password',
        username_from: 'login.username',
      }),
    ).toStrictEqual([
      { name: 'login.username', selector: 'login.username', role: 'username' },
      { name: 'password', selector: 'password', role: 'secret' },
    ]);
    expect(
      httpSchemas.credentialFields({ mode: 'header', field: 'custom.API key', name: 'x-api-key' }),
    ).toStrictEqual([{ name: 'custom.API key', selector: 'custom.API key', role: 'secret' }]);
    expect(httpSchemas.credentialFields(GRAPH)).toStrictEqual([
      { name: 'custom.client-secret', selector: 'custom.client-secret', role: 'secret' },
    ]);
    expect(
      httpSchemas.credentialFields({
        ...GRAPH,
        grant: 'refresh_token',
        refresh_token_field: 'custom.refresh-token',
      }),
    ).toStrictEqual([
      { name: 'custom.client-secret', selector: 'custom.client-secret', role: 'secret' },
      { name: 'custom.refresh-token', selector: 'custom.refresh-token', role: 'secret' },
    ]);
  });

  it('ACT-81 ACT-79 ACT-35 reports save-time problems: graph off graph.microsoft.com, query mode without allow_query_credentials, and a path pattern that is not a normalised path', () => {
    expect(httpSchemas.saveProblems(documents())).toStrictEqual([]);
    expect(httpSchemas.saveProblems(documents({ credential: GRAPH }))).toStrictEqual([
      'credential.mapping: the graph mode requires base_url https://graph.microsoft.com',
    ]);
    expect(
      httpSchemas.saveProblems(
        documents({ destination: { base_url: 'https://graph.microsoft.com' }, credential: GRAPH }),
      ),
    ).toStrictEqual([]);
    const query: HttpCredential = { mode: 'query', field: 'password', name: 'key' };
    expect(httpSchemas.saveProblems(documents({ credential: query }))).toStrictEqual([
      'credential.mapping: the query mode requires policy.allow_query_credentials',
    ]);
    const allowingQuery = httpPolicySchema.parse({
      allowed_paths: ['/**'],
      allow_query_credentials: true,
    });
    expect(
      httpSchemas.saveProblems(documents({ credential: query, policy: allowingQuery })),
    ).toStrictEqual([]);
    const oddPaths = httpPolicySchema.parse({
      allowed_paths: ['v1/*', '/../x', '/a/%41*', '/ok/**'],
    });
    expect(httpSchemas.saveProblems(documents({ policy: oddPaths }))).toStrictEqual([
      'policy.allowed_paths: "v1/*" must start with / and stay under base_url',
      'policy.allowed_paths: "/../x" must start with / and stay under base_url',
      'policy.allowed_paths: "/a/%41*" is not in normalised form; write it as "/a/A*"',
    ]);
  });

  it('ACT-43 summarises the destination as host and base path only', () => {
    expect(httpSchemas.summariseDestination({ base_url: 'https://api.example.com:8443/v1/' })).toBe(
      'api.example.com:8443/v1/',
    );
    expect(httpSchemas.summariseDestination({ base_url: 'https://api.example.com' })).toBe(
      'api.example.com',
    );
  });
});
