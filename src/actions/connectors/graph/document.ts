/**
 * The `graph` credential adapter document (spec §14.3, ACT-81): the tenant
 * and application the token is obtained for, the grant, the scope and the
 * vault fields holding the client secret and, for the refresh-token grant,
 * the refresh token. The document is one mode of the `http` connector's
 * credential union; the runtime that uses it is `./adapter.ts`.
 *
 * `tenant_id` and `client_id` are validated by shape rather than by asking
 * Microsoft: both go into a URL path, so anything that is not a GUID or a
 * domain name is refused at save rather than escaped later.
 */
import { z } from 'zod';

import type { CredentialField } from '../connector.ts';

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
export const GRAPH_TOKEN_HOST = 'login.microsoftonline.com';

const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/**
A verified domain or an `*.onmicrosoft.com` name: two or more labels of letters, digits and hyphens.
*/
const DOMAIN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i;

const guidSchema = z.string().regex(GUID, 'must be a GUID');

const tenantSchema = z
  .string()
  .refine((text) => GUID.test(text) || DOMAIN.test(text), 'must be a GUID or a domain name');

const fieldSelectorSchema = z.string().min(1);

export const graphCredentialSchema = z
  .strictObject({
    mode: z.literal('graph'),
    tenant_id: tenantSchema,
    client_id: guidSchema,
    grant: z.enum(['client_credentials', 'refresh_token']),
    scope: z.string().min(1).default(GRAPH_DEFAULT_SCOPE),
    secret_field: fieldSelectorSchema,
    refresh_token_field: fieldSelectorSchema.optional(),
  })
  .refine((graph) => graph.grant !== 'refresh_token' || graph.refresh_token_field !== undefined, {
    message: 'refresh_token_field is required for the refresh_token grant',
  });

export type GraphCredential = z.output<typeof graphCredentialSchema>;

/**
ACT-4: the client secret and, for the refresh-token grant, the refresh token.
*/
export function graphCredentialFields(credential: GraphCredential): readonly CredentialField[] {
  const field = (selector: string): CredentialField => ({
    name: selector,
    selector,
    role: 'secret',
  });
  return credential.refresh_token_field === undefined
    ? [field(credential.secret_field)]
    : [field(credential.secret_field), field(credential.refresh_token_field)];
}

/**
 * ACT-81: the destination must be Microsoft Graph itself. The origin is
 * exact — national clouds are a separate host and are not supported — while
 * a path prefix under it is allowed, so a target may be pinned to one API
 * version (`https://graph.microsoft.com/v1.0`) and write its policy patterns
 * relative to that.
 */
export function graphDestinationProblems(baseUrl: string): readonly string[] {
  return new URL(baseUrl).origin === GRAPH_ORIGIN
    ? []
    : [`credential.mapping: the graph mode requires base_url on ${GRAPH_ORIGIN}`];
}
