/**
 * The `oauth2` credential adapter document (spec §14.3a, ACT-124): the token
 * endpoint, the grant, the client and how it authenticates there, the vault
 * fields holding the client secret and, for the refresh-token grant, the
 * refresh token, and the header the access token goes in. It is one mode of
 * the `http` connector's credential union, served by the same token service
 * as `graph` (`./adapter.ts`), which reads it through `./exchange.ts`.
 *
 * `token_url` is `https://` only, even on an internal target, because the
 * client secret travels to it. `client_id` is a literal, not a secret; it
 * is checked by shape because it is placed in a form body or a Basic header.
 */
import { z } from 'zod';

import { headerNameSchema } from '../http/header-name.ts';

import type { CredentialField, Endpoint } from '../connector.ts';

export const OAUTH2_DEFAULT_HEADER = 'authorization';
export const OAUTH2_DEFAULT_PREFIX = 'Bearer ';

/**
Printable ASCII without the space, 1 to 512 characters: a GUID, `1000.ABCDEF` and the like.
*/
const CLIENT_ID = /^[\u{21}-\u{7E}]{1,512}$/u;

function tokenUrlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') {
    return 'must be an https:// URL, even on an internal target: the client secret is sent to it';
  }
  if (url.search !== '' || url.hash !== '' || text.endsWith('?') || text.endsWith('#')) {
    return 'must not carry a query string or fragment';
  }
  return url.username !== '' || url.password !== '' ? 'must not carry credentials' : undefined;
}

const tokenUrlSchema = z.string().superRefine((text, context) => {
  const problem = tokenUrlProblem(text);
  if (problem !== undefined) {
    context.addIssue({ code: 'custom', message: problem });
  }
});

const fieldSelectorSchema = z.string().min(1);

export const oauth2CredentialSchema = z
  .strictObject({
    mode: z.literal('oauth2'),
    token_url: tokenUrlSchema,
    grant: z.enum(['client_credentials', 'refresh_token']),
    client_id: z.string().regex(CLIENT_ID, 'must be 1 to 512 printable characters, no spaces'),
    secret_field: fieldSelectorSchema,
    refresh_token_field: fieldSelectorSchema.optional(),
    scope: z.string().min(1).optional(),
    client_auth: z.enum(['post', 'basic']).default('post'),
    name: headerNameSchema.default(OAUTH2_DEFAULT_HEADER),
    prefix: z.string().default(OAUTH2_DEFAULT_PREFIX),
  })
  .refine(
    (oauth2) => oauth2.grant !== 'refresh_token' || oauth2.refresh_token_field !== undefined,
    { message: 'refresh_token_field is required for the refresh_token grant' },
  )
  .refine(
    (oauth2) => oauth2.grant !== 'client_credentials' || oauth2.refresh_token_field === undefined,
    { message: 'refresh_token_field is used by the refresh_token grant only; remove it' },
  );

export type OAuth2Credential = z.output<typeof oauth2CredentialSchema>;

/**
 * ACT-124, ACT-125: the token endpoint's host, checked at save by the ACT-3
 * rule and resolved again, by the ACT-55 rule, each time a token is
 * exchanged. It is never an endpoint of the destination, so a call never
 * pins it.
 */
export function oauth2TokenEndpoint(credential: Pick<OAuth2Credential, 'token_url'>): Endpoint {
  return { host: new URL(credential.token_url).hostname, tls: true };
}

/**
 * ACT-4: the client secret and, for the refresh-token grant, the refresh
 * token — for `graph` and `oauth2` alike, whose documents name them the same
 * way. The engine fetches exactly these before the run (ACT-50).
 */
export function adapterCredentialFields(credential: {
  readonly secret_field: string;
  readonly refresh_token_field?: string | undefined;
}): readonly CredentialField[] {
  const field = (selector: string): CredentialField => ({
    name: selector,
    selector,
    role: 'secret',
  });
  return credential.refresh_token_field === undefined
    ? [field(credential.secret_field)]
    : [field(credential.secret_field), field(credential.refresh_token_field)];
}
