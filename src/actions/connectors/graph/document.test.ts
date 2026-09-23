import { describe, expect, it } from 'vitest';

import { GRAPH_CLIENT, GRAPH_TENANT, graphCredential } from '../../../test-support/graph.ts';

import {
  GRAPH_DEFAULT_SCOPE,
  graphCredentialFields,
  graphCredentialSchema,
  graphDestinationProblems,
} from './document.ts';

const BASE = {
  mode: 'graph',
  tenant_id: GRAPH_TENANT,
  client_id: GRAPH_CLIENT,
  grant: 'client_credentials',
  secret_field: 'custom.client-secret',
};

describe('the graph adapter document', () => {
  it('ACT-81 accepts a GUID or a domain tenant, defaults the scope and keeps the fields', () => {
    expect(graphCredentialSchema.parse(BASE)).toStrictEqual({
      ...BASE,
      scope: GRAPH_DEFAULT_SCOPE,
    });
    expect(graphCredentialSchema.safeParse({ ...BASE, tenant_id: GRAPH_CLIENT }).success).toBe(
      true,
    );
    expect(graphCredentialSchema.safeParse({ ...BASE, tenant_id: 'contoso.com' }).success).toBe(
      true,
    );
    expect(graphCredentialSchema.parse({ ...BASE, scope: 'Files.Read' }).scope).toBe('Files.Read');
  });

  it('ACT-81 refuses a tenant or client id that is neither a GUID nor a domain, so neither can shape a URL', () => {
    for (const tenant of ['tenant', 'a/b', 'contoso.com/../evil', '../..', 'a b.com', '']) {
      expect(graphCredentialSchema.safeParse({ ...BASE, tenant_id: tenant }).success).toBe(false);
    }
    expect(
      graphCredentialSchema.safeParse({ ...BASE, client_id: 'contoso.com' }).error?.issues[0]
        ?.message,
    ).toBe('must be a GUID');
  });

  it('ACT-81 requires refresh_token_field for the refresh_token grant only', () => {
    expect(
      graphCredentialSchema.safeParse({ ...BASE, grant: 'refresh_token' }).error?.issues[0]
        ?.message,
    ).toBe('refresh_token_field is required for the refresh_token grant');
    expect(
      graphCredentialSchema.safeParse({
        ...BASE,
        grant: 'refresh_token',
        refresh_token_field: 'custom.refresh',
      }).success,
    ).toBe(true);
    expect(graphCredentialSchema.safeParse({ ...BASE, secret_field: '' }).success).toBe(false);
  });

  it('ACT-4 names the client secret, and the refresh token when the mapping has one', () => {
    expect(graphCredentialFields(graphCredential())).toStrictEqual([
      { name: 'password', selector: 'password', role: 'secret' },
    ]);
    expect(
      graphCredentialFields(
        graphCredential({ grant: 'refresh_token', refresh_token_field: 'custom.refresh' }),
      ),
    ).toStrictEqual([
      { name: 'password', selector: 'password', role: 'secret' },
      { name: 'custom.refresh', selector: 'custom.refresh', role: 'secret' },
    ]);
  });

  it('ACT-81 allows a path prefix under the Graph origin and nothing on another origin', () => {
    expect(graphDestinationProblems('https://graph.microsoft.com')).toStrictEqual([]);
    expect(graphDestinationProblems('https://graph.microsoft.com/v1.0')).toStrictEqual([]);
    expect(graphDestinationProblems('https://graph.microsoft.com/beta/')).toStrictEqual([]);
    expect(graphDestinationProblems('https://graph.microsoft.de/v1.0')).toStrictEqual([
      'credential.mapping: the graph mode requires base_url on https://graph.microsoft.com',
    ]);
    expect(graphDestinationProblems('https://graph.microsoft.com.evil.example')).toStrictEqual([
      'credential.mapping: the graph mode requires base_url on https://graph.microsoft.com',
    ]);
  });
});
