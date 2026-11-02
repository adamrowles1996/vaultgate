import { z } from 'zod';

import { validateRedirectUri } from '../redirect-uri.ts';

const httpsUrl = z.url({ protocol: /^https$/ });

const redirectUri = z.string().refine((text) => validateRedirectUri(text).ok, {
  message: 'must be an https URL or a loopback http address',
});

const SUPPORTED_GRANT_TYPES: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token']);

/**
 * OAUTH-9, OAUTH-11: a client may list grant types vaultgate does not offer (Claude's hosted
 * document names `urn:ietf:params:oauth:grant-type:jwt-bearer`, for one). They are dropped
 * rather than refused, as RFC 7591 section 2 lets a server do, and the token endpoint never
 * honours them; `authorization_code` itself must still be listed.
 */
export const grantTypesSchema = z
  .array(z.string().min(1))
  .refine((types) => types.includes('authorization_code'), {
    message: 'must include "authorization_code"',
  })
  .transform((types) => types.filter((type) => SUPPORTED_GRANT_TYPES.has(type)));

const PUBLIC_CLIENT = 'none';

interface AuthMethods {
  readonly token_endpoint_auth_method?: string | undefined;
  readonly token_endpoint_auth_methods_supported?: readonly string[] | undefined;
}

/**
 * OAUTH-5, OAUTH-9: the token endpoint serves public clients only, so the client must be able to
 * use `none`. A document that lists `token_endpoint_auth_methods_supported` (MCP SEP-3149;
 * ChatGPT's does) names every method its client can use, and the singular
 * `token_endpoint_auth_method` beside it is only a preference: the client picks a method both
 * sides support. The list, when present, decides; without it the singular field must be absent
 * or `none`.
 */
function publicClientIssues(document: AuthMethods, context: z.RefinementCtx): void {
  const supported = document.token_endpoint_auth_methods_supported;
  if (supported !== undefined) {
    if (!supported.includes(PUBLIC_CLIENT)) {
      context.addIssue({
        code: 'custom',
        path: ['token_endpoint_auth_methods_supported'],
        message: 'must include "none": only public clients are supported',
      });
    }
    return;
  }
  const method = document.token_endpoint_auth_method;
  if (method !== undefined && method !== PUBLIC_CLIENT) {
    context.addIssue({
      code: 'custom',
      path: ['token_endpoint_auth_method'],
      message: 'must be "none": only public clients are supported',
    });
  }
}

/**
 * OAUTH-9 / OAUTH-5: the required fields, the optional fields validated when
 * present, everything else passed through untouched.
 */
const cimdDocumentSchema = z
  .looseObject({
    client_id: httpsUrl,
    client_name: z.string().trim().min(1),
    redirect_uris: z.array(redirectUri).min(1),
    token_endpoint_auth_method: z.string().min(1).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string().min(1)).min(1).optional(),
    grant_types: grantTypesSchema.optional(),
    response_types: z.array(z.literal('code')).optional(),
    application_type: z.enum(['native', 'web']).optional(),
    scope: z.string().optional(),
    client_uri: httpsUrl.optional(),
    logo_uri: httpsUrl.optional(),
    tos_uri: httpsUrl.optional(),
    policy_uri: httpsUrl.optional(),
    contacts: z.array(z.string()).optional(),
    software_id: z.string().optional(),
    software_version: z.string().optional(),
  })
  .superRefine(publicClientIssues);

export type CimdDocument = z.output<typeof cimdDocumentSchema>;

/**
 * Every problem zod found, path first, so an operator can fix a document in one pass.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * OAUTH-9: the document's `client_id` must be exactly the URL it was
 * fetched from; a hosted document may not claim another identity.
 */
export function parseCimdDocument(
  clientId: string,
  json: unknown,
):
  | { readonly ok: true; readonly document: CimdDocument }
  | { readonly ok: false; readonly reason: string } {
  const parsed = cimdDocumentSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: describeIssues(parsed.error) };
  }
  return parsed.data.client_id === clientId
    ? { ok: true, document: parsed.data }
    : { ok: false, reason: 'client_id does not equal the document URL' };
}
