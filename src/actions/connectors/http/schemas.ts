/**
 * The `http` connector's target documents (spec §14.2) with the `graph`
 * credential adapter document of §14.3 (ACT-81) as a credential mode. The
 * runtime (request builder, injection, pinned transport) lands with M9's
 * third pull request and the Graph exchange with M10; these schemas are here
 * first because the account page validates and edits targets with them.
 */
import { z } from 'zod';

import { commonPolicySchema, httpSubject } from '../../policy.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

const GRAPH_BASE_URL = 'https://graph.microsoft.com';
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BODY_BYTES = 256 * 1024;

/**
RFC 9110 token characters; header names are compared lower-cased (ACT-34).
*/
const headerNameSchema = z
  .string()
  .regex(/^[\w!#$%&'*+.^`|~-]+$/, 'must be an HTTP header name')
  .transform((name) => name.toLowerCase());

function baseUrlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'must be an https:// (or, on an internal target, http://) URL';
  }
  if (url.search !== '' || url.hash !== '' || text.endsWith('?') || text.endsWith('#')) {
    return 'must not carry a query string or fragment';
  }
  return url.username !== '' || url.password !== '' ? 'must not carry credentials' : undefined;
}

const baseUrlSchema = z.string().superRefine((text, context) => {
  const problem = baseUrlProblem(text);
  if (problem !== undefined) {
    context.addIssue({ code: 'custom', message: problem });
  }
});

export const httpDestinationSchema = z.strictObject({
  base_url: baseUrlSchema,
});

const fieldSelectorSchema = z.string().min(1);

const withField = { field: fieldSelectorSchema };

export const httpCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('bearer'), ...withField }),
  z.strictObject({
    mode: z.literal('basic'),
    ...withField,
    username_from: fieldSelectorSchema.default('login.username'),
  }),
  z.strictObject({
    mode: z.literal('header'),
    ...withField,
    name: headerNameSchema,
    prefix: z.string().optional(),
  }),
  z.strictObject({
    mode: z.literal('query'),
    ...withField,
    name: z.string().min(1),
    prefix: z.string().optional(),
  }),
  z
    .strictObject({
      mode: z.literal('graph'),
      tenant_id: z.string().min(1),
      client_id: z.string().min(1),
      grant: z.enum(['client_credentials', 'refresh_token']),
      scope: z.string().min(1).default(GRAPH_DEFAULT_SCOPE),
      secret_field: fieldSelectorSchema,
      refresh_token_field: fieldSelectorSchema.optional(),
    })
    .refine((graph) => graph.grant !== 'refresh_token' || graph.refresh_token_field !== undefined, {
      message: 'refresh_token_field is required for the refresh_token grant',
    }),
]);

export const httpPolicySchema = commonPolicySchema.extend({
  allowed_methods: z.array(z.enum(HTTP_METHODS)).min(1).default(['GET', 'HEAD']),
  allowed_paths: z.array(z.string().min(1)).min(1),
  allowed_request_headers: z
    .array(headerNameSchema)
    .default(['accept', 'content-type', 'if-none-match']),
  response_headers: z
    .array(headerNameSchema)
    .default(['content-type', 'content-length', 'location', 'retry-after']),
  max_body_bytes: z.number().int().min(1).max(MAX_BODY_BYTES).default(DEFAULT_BODY_BYTES),
  follow_redirects: z.boolean().default(false),
  allow_query_credentials: z.boolean().default(false),
});

export type HttpDestination = z.output<typeof httpDestinationSchema>;
export type HttpCredential = z.output<typeof httpCredentialSchema>;
export type HttpPolicy = z.output<typeof httpPolicySchema>;

function endpoints(destination: HttpDestination): readonly Endpoint[] {
  const url = new URL(destination.base_url);
  return [{ host: url.hostname, tls: url.protocol === 'https:' }];
}

function field(selector: string, role: CredentialField['role'] = 'secret'): CredentialField {
  return { name: selector, selector, role };
}

function credentialFields(credential: HttpCredential): readonly CredentialField[] {
  switch (credential.mode) {
    case 'basic': {
      return [field(credential.username_from, 'username'), field(credential.field)];
    }
    case 'graph': {
      const refresh =
        credential.refresh_token_field === undefined ? [] : [field(credential.refresh_token_field)];
      return [field(credential.secret_field), ...refresh];
    }
    default: {
      return [field(credential.field)];
    }
  }
}

/**
 * ACT-35: subjects are matched after normalisation, so a pattern is written
 * in normalised form too, or it could never match; one that climbs above
 * `base_url` could never be reached.
 */
function pathPatternProblems(pattern: string): readonly string[] {
  const normalised = httpSubject(pattern);
  if (normalised === undefined) {
    return [`policy.allowed_paths: "${pattern}" must start with / and stay under base_url`];
  }
  return normalised === pattern
    ? []
    : [`policy.allowed_paths: "${pattern}" is not in normalised form; write it as "${normalised}"`];
}

export const httpSchemas: ConnectorSchemas<HttpDestination, HttpCredential, HttpPolicy> = {
  kind: 'http',
  destinationSchema: httpDestinationSchema,
  credentialSchema: httpCredentialSchema,
  policySchema: httpPolicySchema,
  endpoints,
  credentialFields,
  saveProblems({ destination, credential, policy }) {
    const problems: string[] = [];
    if (credential.mode === 'graph' && destination.base_url !== GRAPH_BASE_URL) {
      problems.push(`credential.mapping: the graph mode requires base_url ${GRAPH_BASE_URL}`);
    }
    if (credential.mode === 'query' && !policy.allow_query_credentials) {
      problems.push('credential.mapping: the query mode requires policy.allow_query_credentials');
    }
    return [
      ...problems,
      ...policy.allowed_paths.flatMap((pattern) => pathPatternProblems(pattern)),
    ];
  },
  summariseDestination(destination) {
    const url = new URL(destination.base_url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  },
};
