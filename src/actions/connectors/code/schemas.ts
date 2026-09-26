/**
 * The `code` connector's target documents (spec 14.8): a GitHub repository,
 * the vault field holding a read-only token (or none for a public
 * repository), and the policy that bounds what is fetched, indexed and
 * returned. The static half every build carries; the runtime is
 * `./index.ts`. The console calls the kind "Semble · GitHub code search".
 */
import { z } from 'zod';

import { commonPolicySchema } from '../../policy.ts';

import { MAX_PATTERN_BYTES, patternBytes, patternListSchema } from './patterns.ts';
import {
  configuredReferenceProblem as configuredReferenceProblem,
  repoProblem as repoProblem,
} from './references.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const CONTENT_TYPES = ['code', 'docs', 'config'] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/**
ACT-106: the secret-file names excluded unless the operator replaces the list.
*/
export const DEFAULT_EXCLUDE: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '*.kdbx',
  '.git-credentials',
  '.netrc',
  '.npmrc',
];

export const GITHUB_API_HOST = 'api.github.com';
export const GITHUB_ARCHIVE_HOST = 'codeload.github.com';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/**
ACT-112: the wait must end with room left for the answer inside the call's own timeout.
*/
const WAIT_MARGIN_MS = 10_000;
const MS_PER_SECOND = 1000;

function checked(problem: (text: string) => string | undefined): z.ZodString {
  return z.string().superRefine((text, context) => {
    const found = problem(text);
    if (found !== undefined) {
      context.addIssue({ code: 'custom', message: found });
    }
  });
}

export const codeDestinationSchema = z.strictObject({
  forge: z.literal('github').default('github'),
  repository: checked(repoProblem),
  /**
  Absent: the repository's default branch, looked up at each freshness check (ACT-104).
  */
  ref: checked(configuredReferenceProblem).optional(),
});

export const codeCredentialSchema = z.strictObject({
  /**
  `null`: a public repository read without a token (ACT-103).
  */
  token_field: z.string().min(1).nullable().default('password'),
});

const contentSchema = z
  .array(z.enum(CONTENT_TYPES))
  .min(1)
  .refine((types) => new Set(types).size === types.length, 'must not repeat a content type');

function bounded(min: number, max: number, fallback: number): z.ZodDefault<z.ZodNumber> {
  return z.number().int().min(min).max(max).default(fallback);
}

export const codePolicySchema = commonPolicySchema
  .extend({
    timeout_ms: bounded(MS_PER_SECOND, 300_000, 150_000),
    refresh_interval_s: bounded(60, 86_400, 300),
    content: contentSchema.default([...CONTENT_TYPES]),
    allow_ref: z.boolean().default(true),
    max_top_k: bounded(1, 200, 50),
    build_wait_s: bounded(0, 290, 90),
    include: patternListSchema.default([]),
    exclude: patternListSchema.default([...DEFAULT_EXCLUDE]),
    max_archive_bytes: bounded(MIB, GIB, 256 * MIB),
    max_files: bounded(1, 200_000, 50_000),
    max_total_bytes: bounded(MIB, 4 * GIB, GIB),
    max_file_bytes: bounded(1024, 16 * MIB, MIB),
    build_timeout_s: bounded(10, 3600, 600),
    allow_read: z.boolean().default(true),
    max_read_lines: bounded(1, 2000, 400),
  })
  .superRefine((policy, context) => {
    // The build spec travels in one header line the sidecar caps at 64 KiB.
    if (patternBytes(policy.include, policy.exclude) > MAX_PATTERN_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['include'],
        message: 'include and exclude together must be at most 32 KiB, as JSON',
      });
    }
  });

export type CodeDestination = z.output<typeof codeDestinationSchema>;
export type CodeCredential = z.output<typeof codeCredentialSchema>;
export type CodePolicy = z.output<typeof codePolicySchema>;

/**
ACT-103: the API and the archive host, both over TLS; neither is ever internal.
*/
function endpoints(): readonly Endpoint[] {
  return [
    { host: GITHUB_API_HOST, tls: true },
    { host: GITHUB_ARCHIVE_HOST, tls: true },
  ];
}

function credentialFields(credential: CodeCredential): readonly CredentialField[] {
  return credential.token_field === null
    ? []
    : [{ name: credential.token_field, selector: credential.token_field, role: 'secret' }];
}

function saveProblems({ policy }: { readonly policy: CodePolicy }): readonly string[] {
  return policy.build_wait_s * MS_PER_SECOND + WAIT_MARGIN_MS > policy.timeout_ms
    ? ['policy.build_wait_s: must end at least 10 seconds before policy.timeout_ms']
    : [];
}

/**
The selection a policy's `content` names, in the order `semble` lists content types.
*/
export function normaliseContent(types: readonly ContentType[]): readonly ContentType[] {
  return CONTENT_TYPES.filter((type) => types.includes(type));
}

export const codeSchemas: ConnectorSchemas<CodeDestination, CodeCredential, CodePolicy> = {
  kind: 'code',
  destinationSchema: codeDestinationSchema,
  credentialSchema: codeCredentialSchema,
  policySchema: codePolicySchema,
  endpoints,
  credentialFields,
  saveProblems,
  summariseDestination(destination) {
    return destination.ref === undefined
      ? destination.repository
      : `${destination.repository}@${destination.ref}`;
  },
  /**
  ACT-49: every code tool reads; nothing a code target does is a write.
  */
  allowsNonRead() {
    return false;
  },
  internalRefused: 'internal: a code target reaches GitHub over the internet and is never internal',
};
