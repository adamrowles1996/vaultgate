/**
 * The `include` and `exclude` patterns of a code policy (14.8, ACT-106), held
 * to what the sidecar accepts so a policy that saves is a policy that builds
 * (`sidecars/code/PROTOCOL.md`): each pattern a single line of 1 to 1 024
 * characters in valid gitignore syntax, at most 100 of each, and both lists
 * together small enough that the build spec, base64url-encoded into the
 * `X-Vaultgate-Build` header, stays well inside the sidecar's 64 KiB header
 * line.
 */
import { z } from 'zod';

export const MAX_PATTERNS = 100;
export const MAX_PATTERN_LENGTH = 1024;
/**
 * The two lists as the build spec carries them, as JSON: 32 KiB encodes to
 * under 44 KiB of base64url, leaving the rest of the spec and the header
 * name some 20 KiB of room below the sidecar's 64 KiB line limit.
 */
export const MAX_PATTERN_BYTES = 32 * 1024;

const LINE_BREAK = /[\0\n\r]/u;

/**
 * A bracket expression whose range runs backwards (`[z-a]`), which gitignore
 * matching, like `pathspec`, cannot compile. The expression is read as
 * `pathspec` reads it: an optional `!` or `^`, then a leading `]` taken
 * literally, up to the next `]`; an unclosed `[` is a literal.
 */
function hasReversedRange(pattern: string): boolean {
  for (let open = pattern.indexOf('['); open !== -1; open = pattern.indexOf('[', open + 1)) {
    let start = open + 1;
    if (pattern[start] === '!' || pattern[start] === '^') {
      start += 1;
    }
    const close = pattern.indexOf(']', pattern[start] === ']' ? start + 1 : start);
    // Code points, as a regular expression class reads them.
    const body = close === -1 ? '' : pattern.slice(start, close);
    const points = Array.from(body, (character) => character.codePointAt(0));
    if (isReversed(points)) {
      return true;
    }
  }
  return false;
}

const DASH = 0x2d;

/**
Ranges read left to right as a regular expression class reads them: `a-c-e` is `a-c`, `-` and `e`.
*/
function isReversed(points: readonly (number | undefined)[]): boolean {
  let index = 0;
  while (index + 2 < points.length) {
    if (points[index + 1] !== DASH) {
      index += 1;
    } else if (Number(points[index]) > Number(points[index + 2])) {
      return true;
    } else {
      index += 3;
    }
  }
  return false;
}

/**
A trailing backslash that escapes nothing.
*/
function hasDanglingEscape(pattern: string): boolean {
  const trailing = /\\+$/u.exec(pattern)?.[0].length ?? 0;
  return trailing % 2 === 1;
}

/**
Why one pattern is refused, or `undefined`.
*/
export function patternProblem(pattern: string): string | undefined {
  if (LINE_BREAK.test(pattern)) {
    return 'must be a single line';
  }
  if (pattern === '!') {
    return 'negates nothing';
  }
  if (hasReversedRange(pattern)) {
    return 'has a character range that runs backwards';
  }
  return hasDanglingEscape(pattern) ? 'ends with a backslash that escapes nothing' : undefined;
}

const patternSchema = z
  .string()
  .min(1)
  .max(MAX_PATTERN_LENGTH)
  .superRefine((pattern, context) => {
    const problem = patternProblem(pattern);
    if (problem !== undefined) {
      context.addIssue({ code: 'custom', message: `"${pattern.slice(0, 64)}" ${problem}` });
    }
  });

export const patternListSchema = z.array(patternSchema).max(MAX_PATTERNS);

/**
The JSON size of both lists, as the build spec carries them.
*/
export function patternBytes(include: readonly string[], exclude: readonly string[]): number {
  return Buffer.byteLength(JSON.stringify(include)) + Buffer.byteLength(JSON.stringify(exclude));
}
