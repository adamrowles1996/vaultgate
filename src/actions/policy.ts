/**
 * Policy semantics shared by every connector (spec §13.7): the glob-like
 * pattern matcher of ACT-34, HTTP subject normalisation (ACT-35), the common
 * policy fields of ACT-1 and the decision shape of ACT-39. No regular
 * expression is ever built from operator input.
 */
import { z } from 'zod';

export type PatternKind = 'path' | 'command';

export type OperationKind = 'read' | 'write' | 'shell' | 'act';

export type StatementClass = 'read' | 'dml' | 'ddl' | 'other';

export type PolicyReason =
  | 'method'
  | 'path'
  | 'header'
  | 'body_size'
  | 'operation'
  | 'statement_count'
  | 'statement_class'
  | 'statement_pattern'
  | 'command'
  | 'command_size'
  | 'origin'
  | 'element';

/**
ACT-39, exactly.
*/
export type PolicyDecision =
  | { readonly allowed: true; readonly operation: OperationKind; readonly class?: StatementClass }
  | { readonly allowed: false; readonly reason: PolicyReason };

type Token =
  { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'star' | 'double' };

const MAX_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_OUTPUT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_CALLS_PER_MINUTE = 600;
const DEFAULT_CALLS_PER_MINUTE = 60;

/**
The common policy fields of ACT-1 with the defaults and ceilings of §13.11.
*/
export const commonPolicySchema = z.object({
  timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  max_output_bytes: z
    .number()
    .int()
    .min(MIN_OUTPUT_BYTES)
    .max(MAX_OUTPUT_BYTES)
    .default(DEFAULT_OUTPUT_BYTES),
  rate_limit_per_minute: z
    .number()
    .int()
    .min(1)
    .max(MAX_CALLS_PER_MINUTE)
    .default(DEFAULT_CALLS_PER_MINUTE),
  confirm_writes: z.boolean().default(false),
});

export type CommonPolicy = z.output<typeof commonPolicySchema>;

/**
 * `*` and, for paths, `**` are the only special characters; a `**` in a
 * command pattern is two single stars, which ACT-35 refuses at save anyway.
 */
function tokenise(pattern: string, kind: PatternKind): readonly Token[] {
  const tokens: Token[] = [];
  let literal = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character !== '*') {
      literal += character;
      continue;
    }
    if (literal.length > 0) {
      tokens.push({ kind: 'literal', text: literal });
      literal = '';
    }
    const isDouble = kind === 'path' && pattern.charAt(index + 1) === '*';
    tokens.push({ kind: isDouble ? 'double' : 'star' });
    index += isDouble ? 1 : 0;
  }
  if (literal.length > 0) {
    tokens.push({ kind: 'literal', text: literal });
  }
  return tokens;
}

/**
 * The subject positions a prefix of the pattern can end at (index `n`
 * means the whole subject), advanced one token at a time over two buffers
 * that swap roles, so a match costs one sweep of the subject per token.
 */
class Reach {
  readonly #subject: string;
  #current: Uint8Array;
  #next: Uint8Array;

  constructor(subject: string) {
    this.#subject = subject;
    this.#current = new Uint8Array(subject.length + 1);
    this.#next = new Uint8Array(subject.length + 1);
    this.#current[0] = 1;
  }

  #swap(): void {
    const finished = this.#next;
    this.#next = this.#current;
    this.#current = finished;
  }

  get isComplete(): boolean {
    return this.#current[this.#subject.length] === 1;
  }

  literal(text: string): void {
    this.#next.fill(0);
    for (const [position, isReached] of this.#current.entries()) {
      if (isReached === 1 && this.#subject.startsWith(text, position)) {
        this.#next[position + text.length] = 1;
      }
    }
    this.#swap();
  }

  /**
   * A wildcard extends every reachable position forward: `**` to the end,
   * `*` up to and including the next separator's index (the run it matches
   * stops before the separator).
   */
  wildcard(stopAt: ReadonlySet<string> | undefined): void {
    let isOpen = false;
    for (const [position, isReached] of this.#current.entries()) {
      isOpen ||= isReached === 1;
      this.#next[position] = isOpen ? 1 : 0;
      if (stopAt?.has(this.#subject.charAt(position)) === true) {
        isOpen = false;
      }
    }
    this.#swap();
  }
}

/**
 * ACT-34: a path `*` stops at a segment boundary; a command `*` stops at a
 * line terminator, carriage return as well as line feed — a `--` comment ends
 * at a bare CR on both engines, so a `*` that crossed one would let a pattern
 * match a subject the server reads as two lines.
 */
const SEPARATORS: Readonly<Record<PatternKind, ReadonlySet<string>>> = {
  path: new Set(['/']),
  command: new Set(['\n', '\r']),
};

/**
 * ACT-34: anchored at both ends, case-sensitive, `*` stops at `/` (paths) or a
 * line terminator (commands), `**` crosses `/`. Each token advances the set of
 * subject positions the pattern so far can end at in one sweep over the
 * subject, so matching is linear in the subject for a fixed pattern: no
 * backtracking, no ReDoS however the pattern is written.
 */
export function isPatternMatch(pattern: string, subject: string, kind: PatternKind): boolean {
  const separator = SEPARATORS[kind];
  const reach = new Reach(subject);
  for (const token of tokenise(pattern, kind)) {
    if (token.kind === 'literal') {
      reach.literal(token.text);
    } else {
      reach.wildcard(token.kind === 'star' ? separator : undefined);
    }
  }
  return reach.isComplete;
}

/**
 * ACT-35: a command pattern that would allow everything is refused at save
 * unless `any_command` is what the operator means. A non-empty pattern that
 * matches the empty command has no literal at all, so it matches every
 * command.
 */
export function commandPatternProblem(
  patterns: readonly string[],
  isAnyCommand: boolean,
): string | undefined {
  if (isAnyCommand) {
    return undefined;
  }
  const open = patterns.find(
    (pattern) => pattern.length > 0 && isPatternMatch(pattern, '', 'command'),
  );
  return open === undefined
    ? undefined
    : `the command pattern "${open}" would allow every command; set any_command instead`;
}

/**
RFC 3986 §2.3; every other escape keeps its bytes.
*/
const UNRESERVED = /^[\w.~-]$/;
const PERCENT_ESCAPE = /%[\dA-F]{2}/gi;
const HEX = 16;

/**
 * RFC 3986 §6.2.2: percent-encoded unreserved characters are decoded, every
 * other escape is kept with upper-case hex digits, and a malformed `%` stays
 * literal. The expressions are fixed, never built from input.
 */
function decodeUnreserved(text: string): string {
  return text.replaceAll(PERCENT_ESCAPE, (escape) => {
    const character = String.fromCodePoint(Number.parseInt(escape.slice(1), HEX));
    return UNRESERVED.test(character) ? character : escape.toUpperCase();
  });
}

interface DotFreePath {
  readonly path: string;
  /**
  A `..` tried to climb above the root: the request would leave `base_url`.
  */
  readonly escaped: boolean;
}

/**
RFC 3986 §5.2.4 over an absolute path: `.` and `..` segments are resolved; climbing past the root is reported.
*/
function removeDotSegments(path: string): DotFreePath {
  const output: string[] = [];
  let isEscaped = false;
  const segments = path.split('/').slice(1);
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (segment === '..') {
      isEscaped ||= output.length === 0;
      output.pop();
    } else if (segment !== '.') {
      output.push(segment);
    }
    if (isLast && (segment === '.' || segment === '..')) {
      output.push('');
    }
  }
  return { path: `/${output.join('/')}`, escaped: isEscaped };
}

function normalise(pathAndQuery: string): DotFreePath {
  const queryAt = pathAndQuery.indexOf('?');
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const query = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);
  const dotFree = removeDotSegments(decodeUnreserved(path));
  return { path: dotFree.path + decodeUnreserved(query), escaped: dotFree.escaped };
}

/**
 * The policy subject of an `http_request` (ACT-20, ACT-35): the path and
 * query the agent gave, relative to `base_url`, normalised. `undefined` when
 * the path does not start with `/` or a (possibly percent-encoded) `..`
 * would climb above `base_url` (`policy_denied`, reason `path`).
 */
export function httpSubject(path: string): string | undefined {
  if (!path.startsWith('/')) {
    return undefined;
  }
  const subject = normalise(path);
  return subject.escaped ? undefined : subject.path;
}
