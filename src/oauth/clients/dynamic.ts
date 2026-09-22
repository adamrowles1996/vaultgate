import { z } from 'zod';

import { fail, ok, type Result } from '../../result.ts';
import { CREDENTIAL_PREFIX, mintCredential, type RandomSource } from '../credentials.ts';
import { OAuthError } from '../errors.ts';
import { validateRedirectUri } from '../redirect-uri.ts';
import { enabledScopes, isScope, type Scope } from '../scopes.ts';

import { describeIssues } from './cimd-document.ts';

import type { Clock } from '../clock.ts';
import type { ClientsRepo } from '../repositories/clients.ts';

const redirectUri = z.string().refine((text) => validateRedirectUri(text).ok, {
  message: 'must be an https URL or a loopback http address',
});

/**
 * OAUTH-11: the fields vaultgate validates; unknown fields are ignored.
 */
const registrationSchema = z
  .object({
    redirect_uris: z.array(redirectUri).min(1),
    client_name: z.string().trim().min(1).max(200).optional(),
    token_endpoint_auth_method: z.literal('none').default('none'),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .min(1)
      .default(['authorization_code', 'refresh_token']),
    response_types: z.array(z.literal('code')).min(1).default(['code']),
    application_type: z.enum(['native', 'web']).default('web'),
    scope: z.string().optional(),
  })
  .strip();

type RegistrationRequest = z.output<typeof registrationSchema>;

export interface RegistrationResponse extends RegistrationRequest {
  readonly client_id: string;
  readonly client_id_issued_at: number;
}

export interface DynamicRegistrationOptions {
  readonly clients: ClientsRepo;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  readonly enableWriteScope: boolean;
}

function invalidScope(scope: string | undefined, enabled: readonly Scope[]): string | undefined {
  return (scope ?? '')
    .split(' ')
    .filter((entry) => entry.length > 0)
    .find((entry) => !isScope(entry) || !enabled.includes(entry));
}

function metadataError(request: unknown): OAuthError | undefined {
  if (typeof request !== 'object' || request === null) {
    return new OAuthError('invalid_client_metadata', 'the body must be a JSON object');
  }
  const method: unknown = Reflect.get(request, 'token_endpoint_auth_method');
  return method === undefined || method === 'none'
    ? undefined
    : new OAuthError(
        'invalid_client_metadata',
        'only public clients are supported: token_endpoint_auth_method must be "none"',
      );
}

/**
 * OAUTH-5, OAUTH-6, OAUTH-11: validates a registration request and stores
 * the client. No secret is ever issued.
 */
export function registerDynamicClient(
  body: unknown,
  options: DynamicRegistrationOptions,
): Result<RegistrationResponse, OAuthError> {
  const early = metadataError(body);
  if (early !== undefined) {
    return fail(early);
  }
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = describeIssues(parsed.error);
    const code = issue.startsWith('redirect_uris')
      ? 'invalid_redirect_uri'
      : 'invalid_client_metadata';
    return fail(new OAuthError(code, issue));
  }
  const badScope = invalidScope(parsed.data.scope, enabledScopes(options));
  if (badScope !== undefined) {
    return fail(new OAuthError('invalid_client_metadata', `scope "${badScope}" is not available`));
  }
  const at = options.now();
  const response: RegistrationResponse = {
    ...parsed.data,
    client_id: mintCredential(CREDENTIAL_PREFIX.clientId, options.random),
    client_id_issued_at: Math.floor(at / 1000),
  };
  options.clients.upsert({
    id: options.newId(),
    clientId: response.client_id,
    mode: 'dcr',
    clientName: response.client_name,
    redirectUris: response.redirect_uris,
    metadata: Object.fromEntries(Object.entries(response)),
    createdAt: at,
    revokedAt: undefined,
  });
  return ok(response);
}
