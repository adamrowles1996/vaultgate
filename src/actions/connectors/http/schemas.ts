/**
 * The `http` connector's target documents (spec §14.2) with the adapter
 * documents of `graph` (§14.3, ACT-81) and `oauth2` (§14.3a, ACT-124) as
 * credential modes. The schemas are the static half every build carries so
 * the account page can validate and edit targets; the runtime is
 * `./index.ts` and, for the two adapter modes, `../graph/adapter.ts`. The
 * destination may name a private trust in place of the system store: a leaf
 * certificate pin (ACT-121) or a private certificate authority (ACT-122), one
 * or the other and over TLS only.
 */
import { z } from 'zod';

import { commonPolicySchema, httpSubject } from '../../policy.ts';
import { certificateSha256Schema, isPemCertificates, NOT_PEM_PROBLEM } from '../certificates.ts';
import { graphCredentialSchema, graphDestinationProblems } from '../graph/document.ts';
import {
  adapterCredentialFields,
  oauth2CredentialSchema,
  oauth2TokenEndpoint,
} from '../graph/oauth2-document.ts';

import { headerNameSchema } from './header-name.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
ACT-40: the methods that classify as a read; every other method is a write.
*/
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BODY_BYTES = 256 * 1024;

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
  certificate_sha256: certificateSha256Schema.optional(),
  ca_pem: z.string().min(1).optional(),
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
  graphCredentialSchema,
  oauth2CredentialSchema,
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
    case 'graph':
    case 'oauth2': {
      return adapterCredentialFields(credential);
    }
    default: {
      return [field(credential.field)];
    }
  }
}

/**
 * ACT-121, ACT-122: a private trust is a TLS control, so on a plain
 * `base_url` it would be silently ignored, which is worse than a refusal; the
 * pin and the authority each replace the store, so naming both is a mistake
 * too. Every problem is reported at once.
 */
function trustProblems(destination: HttpDestination): readonly string[] {
  const isPinned = destination.certificate_sha256 !== undefined;
  const hasAuthority = destination.ca_pem !== undefined;
  const isPlain = new URL(destination.base_url).protocol === 'http:';
  return [
    ...(isPinned && hasAuthority
      ? [
          'destination.certificate_sha256: give a certificate pin or a certificate authority, not both',
        ]
      : []),
    ...(isPinned && isPlain
      ? ['destination.certificate_sha256: a certificate pin needs an https:// base_url']
      : []),
    ...(hasAuthority && isPlain
      ? ['destination.ca_pem: a certificate authority needs an https:// base_url']
      : []),
    ...(destination.ca_pem === undefined || isPemCertificates(destination.ca_pem)
      ? []
      : [NOT_PEM_PROBLEM]),
  ];
}

/**
ACT-124: the `oauth2` token endpoint, which a save checks by the ACT-3 rule but a call never pins.
*/
function credentialEndpoints(credential: HttpCredential): readonly Endpoint[] {
  return credential.mode === 'oauth2' ? [oauth2TokenEndpoint(credential)] : [];
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
  credentialEndpoints,
  credentialFields,
  saveProblems({ destination, credential, policy }) {
    const problems: string[] = [...trustProblems(destination)];
    if (credential.mode === 'graph') {
      problems.push(...graphDestinationProblems(destination.base_url));
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
  allowsNonRead(policy) {
    return policy.allowed_methods.some((method) => !READ_METHODS.has(method));
  },
};
