/**
 * The three tools of the `code` connector (spec 13.6.7, ACT-110, ACT-111):
 * `code_search` and `code_find_related` take the arguments of `semble`'s own
 * MCP server's `search` and `find_related`, with its defaults, and
 * `code_read` reads a file of a snapshot. `repo` stands in front of every
 * argument list (`RepoArgument`); the descriptions carry `semble`'s own
 * guidance (14.8.6) and ACT-17's.
 */
import { z } from 'zod';

import { parseReference as parseReference } from './references.ts';
import { CONTENT_TYPES } from './schemas.ts';

import type { OutputSchema, ToolAnnotations } from '../../../mcp/tools/definition.ts';
import type { ConnectorTool, OperationSchema, RepoArgument } from '../connector.ts';

export const CODE_SEARCH = 'code_search';
export const CODE_FIND_RELATED = 'code_find_related';
export const CODE_READ = 'code_read';

const MAX_REPOS = 10;
const MAX_QUERY = 1000;
const MAX_TOP_K = 200;
/**
`semble`'s own default; a connection whose `max_top_k` is lower lowers it (ACT-110).
*/
export const DEFAULT_TOP_K = 5;
const MAX_SNIPPET_LINES = 1000;
const DEFAULT_SNIPPET_LINES = 10;
const MAX_FILTERS = 20;
const MAX_PATH_BYTES = 1024;
const LANGUAGE = /^[\w#+.-]{1,64}$/u;
const BAD_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);

export const CONTENT_SELECTIONS = [...CONTENT_TYPES, 'all'] as const;

export type ContentSelection = (typeof CONTENT_SELECTIONS)[number];

/**
ACT-111: why a repository-relative POSIX path is refused, or `undefined`.
*/
export function pathProblem(path: string): string | undefined {
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) {
    return 'must be at most 1 024 bytes';
  }
  if (path.includes('\\') || path.includes('\0')) {
    return 'must not contain a backslash or a NUL';
  }
  const segments = path.split('/');
  const isEscaping = path.startsWith('/') || segments.some((part) => BAD_SEGMENTS.has(part));
  return isEscaping ? 'must be a relative path with no empty, "." or ".." segment' : undefined;
}

const filePathSchema = z.string().superRefine((path, context) => {
  const problem = pathProblem(path);
  if (problem !== undefined) {
    context.addIssue({ code: 'custom', message: problem });
  }
});

const referenceSchema = z
  .string()
  .refine(
    (text) => parseReference(text) !== undefined,
    'must be a branch, a tag, a 40-hex SHA or pr:<n>',
  )
  .describe(
    'Optional: search another commit of the repository than the connection is set to: a ' +
      'branch or tag name, a full 40-character commit SHA, or pr:<number> for the head of a ' +
      'pull request. Only with a single repo, and only where the operator allows it.',
  );

const contentSchema = z
  .enum(CONTENT_SELECTIONS)
  .describe(
    'What to search: code, docs (Markdown and prose), config, or all. Defaults to every type ' +
      'the connection allows.',
  );

/**
 * Optional rather than defaulted, so a call that leaves it out can be given
 * the lower of `semble`'s 5 and the connections' `max_top_k` after the policy
 * has judged it (ACT-110); the schema still advertises 5 as the default.
 */
const topKSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TOP_K)
  .optional()
  .meta({ default: DEFAULT_TOP_K });

const TOP_K_DEFAULT_HELP = 'Default 5, or the connection’s own maximum when that is lower.';

const snippetSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SNIPPET_LINES)
  .nullable()
  .default(DEFAULT_SNIPPET_LINES)
  .describe(
    'Lines of source to include per result. Default (10): the signature and the first lines, ' +
      'enough to confirm the location. 0: file path and line range only. null: the whole chunk. ' +
      'If the snippet does not show enough to confirm the location, call again with null.',
  );

export interface SearchOperation {
  readonly query: string;
  readonly ref?: string | undefined;
  readonly content?: ContentSelection | undefined;
  readonly top_k?: number | undefined;
  readonly max_snippet_lines: number | null;
  readonly paths?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
}

export interface RelatedOperation {
  readonly file_path: string;
  readonly line: number;
  readonly ref?: string | undefined;
  readonly content?: ContentSelection | undefined;
  readonly top_k?: number | undefined;
  readonly max_snippet_lines: number | null;
}

export interface ReadOperation {
  readonly file_path: string;
  readonly ref?: string | undefined;
  readonly start_line?: number | undefined;
  readonly end_line?: number | undefined;
}

export type CodeOperation = SearchOperation | RelatedOperation | ReadOperation;

const searchArguments = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY)
    .describe('Natural language or code query: what the code does, or its name.'),
  ref: referenceSchema.optional(),
  content: contentSchema.optional(),
  top_k: topKSchema.describe(`Number of results to return. ${TOP_K_DEFAULT_HELP}`),
  max_snippet_lines: snippetSchema,
  paths: z
    .array(filePathSchema)
    .max(MAX_FILTERS)
    .optional()
    .describe('Optional: search only these files (exact paths as results give them).'),
  languages: z
    .array(z.string().regex(LANGUAGE))
    .max(MAX_FILTERS)
    .optional()
    .describe('Optional: search only chunks in these languages (python, typescript, markdown…).'),
}) satisfies OperationSchema<SearchOperation>;

const relatedArguments = z.strictObject({
  file_path: filePathSchema.describe(
    'Path to the file as the index stores it: the file_path of a search result.',
  ),
  line: z.number().int().min(1).describe('Line number (1-indexed), from a search result.'),
  ref: referenceSchema.optional(),
  content: contentSchema.optional(),
  top_k: topKSchema.describe(`Number of similar chunks to return. ${TOP_K_DEFAULT_HELP}`),
  max_snippet_lines: snippetSchema,
}) satisfies OperationSchema<RelatedOperation>;

const readArguments = z
  .strictObject({
    file_path: filePathSchema.describe('Repository-relative path of the file, as results give it.'),
    ref: referenceSchema.optional(),
    start_line: z.number().int().min(1).optional().describe('First line to return (1-based).'),
    end_line: z.number().int().min(1).optional().describe('Last line to return (inclusive).'),
  })
  .refine((read) => (read.end_line ?? Infinity) >= (read.start_line ?? 1), {
    path: ['end_line'],
    message: 'must not be before start_line',
  }) satisfies OperationSchema<ReadOperation>;

const resultEntry = z.strictObject({
  repo: z.string().describe('The connection the result comes from.'),
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  score: z.number(),
  language: z.string().nullable(),
  content: z.string().optional(),
});

const repoEntry = z.strictObject({
  repo: z.string(),
  repository: z.string().describe('The GitHub repository, owner/name.'),
  ref: z.string().describe('The branch, tag, SHA or pr:<n> the commit was resolved from.'),
  commit: z.string().describe('The commit the results come from.'),
  indexed_at: z.number().describe('When that commit was indexed, in ms since the epoch.'),
  stale: z.boolean().describe('True when the ref has moved and a newer index is being built.'),
});

const searchOutput = z.strictObject({
  query: z.string(),
  results: z.array(resultEntry),
  repos: z.array(repoEntry),
  truncated: z.boolean(),
  duration_ms: z.number(),
}) satisfies OutputSchema;

const readOutput = z.strictObject({
  repo: z.string(),
  commit: z.string(),
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  total_lines: z.number().int(),
  text: z.string(),
  truncated: z.boolean(),
  duration_ms: z.number(),
}) satisfies OutputSchema;

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function annotations(title: string): ToolAnnotations {
  return { title, ...ANNOTATIONS };
}

const REPO_HELP = 'The name of a code connection from actions_list_targets (connector code)';

function repoArgument(max: number): RepoArgument {
  return {
    max,
    singleOnly: ['ref'],
    description:
      max === 1
        ? `${REPO_HELP}.`
        : `${REPO_HELP}, or a list of up to ${String(max)} of them to search several ` +
          'repositories at once. Results from several repositories prefix file_path with the ' +
          'connection name.',
  };
}

const NO_SECRETS =
  'Results come from a snapshot of the repository at the commit shown; they never contain a ' +
  'credential.';

export const CODE_TOOLS: readonly ConnectorTool<CodeOperation>[] = [
  {
    name: CODE_SEARCH,
    scope: 'actions:code',
    description:
      'Semble code search over a GitHub repository the operator configured. Search once with a ' +
      'focused query describing what the code does or its name; write queries with function or ' +
      'class names or behaviour descriptions, not error messages. Returns file paths and line ' +
      'numbers: go straight there with code_read (or your own checkout), do not repeat the ' +
      'search. Use code_find_related next to find similar code. The first search of a commit ' +
      `builds its index and may take a minute. ${NO_SECRETS}`,
    annotations: annotations('Search code'),
    inputSchema: searchArguments,
    outputSchema: searchOutput,
    repo: repoArgument(MAX_REPOS),
  },
  {
    name: CODE_FIND_RELATED,
    scope: 'actions:code',
    description:
      'Find code similar to a known location: every implementation of an interface, every ' +
      'caller of a function, every test of a class. Use after code_search when you need related ' +
      'code beyond the first result; pass the file_path and a line of a search result, and the ' +
      `same repo (or list of repos) that search used. ${NO_SECRETS}`,
    annotations: annotations('Find related code'),
    inputSchema: relatedArguments,
    outputSchema: searchOutput,
    repo: repoArgument(MAX_REPOS),
  },
  {
    name: CODE_READ,
    scope: 'actions:code',
    description:
      'Read lines of one file from a repository the operator configured, for the context a ' +
      'search snippet leaves out. Returns the text, the line range and the file length; long ' +
      'files are cut at the connection limit (truncated: true), so ask for a range with ' +
      `start_line and end_line. ${NO_SECRETS}`,
    annotations: annotations('Read a file'),
    inputSchema: readArguments,
    outputSchema: readOutput,
    repo: repoArgument(1),
  },
];
