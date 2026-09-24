/**
 * The SQL tokeniser the classifier of ACT-36 stands on: string literals
 * (`'…'` with doubled-quote escapes, `N'…'` on SQL Server, `E'…'` with
 * backslash escapes and `$tag$…$tag$` on PostgreSQL), quoted identifiers
 * (`"…"` on both, `[…]` on SQL Server), line and block comments (block
 * comments nest on PostgreSQL), positional placeholders (`$n` and `@pn`)
 * and everything else. It is not a parser: it exists so a keyword, a
 * statement separator or a placeholder that sits inside a string, a comment
 * or a quoted identifier is never mistaken for one that does not. An
 * unterminated literal or comment runs to the end of the statement, which
 * makes the classifier refuse rather than accept it.
 */
export type SqlEngine = 'mssql' | 'postgres';

export type TokenKind =
  'comment' | 'other' | 'placeholder' | 'quoted' | 'semicolon' | 'string' | 'word';

export interface SqlToken {
  readonly kind: TokenKind;
  readonly text: string;
  /**
  The index just past the token; ACT-36 reads the tail of the statement after the first `;`.
  */
  readonly end: number;
  /**
  The 1-based parameter position of a `placeholder` (`$3`, `@p3` → 3); 0 for every other token.
  */
  readonly position: number;
}

const SPACE = /\s/u;
const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_]/u;
const DIGIT = /\d/u;
const PARAMETER = /^@p\d+$/u;
const BACKSLASH = '\\';

interface Scanned {
  readonly kind: TokenKind;
  readonly end: number;
  readonly position: number;
}

/**
The end of the run of characters from `start` that all match; `start` itself when none does.
*/
function runOf(source: string, start: number, matches: RegExp): number {
  let index = start;
  while (index < source.length && matches.test(source.charAt(index))) {
    index += 1;
  }
  return index;
}

function token(kind: TokenKind, end: number): Scanned {
  return { kind, end, position: 0 };
}

function placeholder(end: number, position: number): Scanned {
  return { kind: 'placeholder', end, position };
}

/**
 * A run delimited by `close`, where the delimiter is escaped by doubling it
 * (`''`, `""`, `]]`); unterminated, it runs to the end.
 */
function endOfDoubled(source: string, start: number, close: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== close) {
      index += 1;
    } else if (source[index + 1] === close) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return source.length;
}

/**
PostgreSQL's `E'…'`, where a backslash escapes the next character as well as the doubling rule.
*/
function endOfEscaped(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === BACKSLASH) {
      index += 2;
    } else if (source[index] !== "'") {
      index += 1;
    } else if (source[index + 1] === "'") {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return source.length;
}

/**
 * A `--` comment ends at the first line terminator, carriage return included.
 * PostgreSQL's lexer defines `non_newline` as `[^\n\r]` and T-SQL ends a line
 * comment at a bare CR too, so a tokeniser that looked for `\n` alone would
 * swallow a statement the server would go on to run (ACT-36).
 */
function endOfLineComment(source: string, start: number): number {
  let index = start;
  while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
    index += 1;
  }
  return index;
}

function endOfBlockComment(source: string, start: number, isNested: boolean): number {
  let depth = 1;
  let index = start + 2;
  while (index < source.length) {
    if (isNested && source.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (source.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return source.length;
}

function endOfDollarString(source: string, start: number, tag: string): number {
  const close = source.indexOf(tag, start + tag.length);
  return close === -1 ? source.length : close + tag.length;
}

/**
The `$tag$` delimiter that opens a dollar-quoted string, or `undefined` when this `$` opens none.
*/
function dollarTag(source: string, index: number): string | undefined {
  if (source[index] !== '$') {
    return undefined;
  }
  const body = WORD_START.test(source.charAt(index + 1))
    ? runOf(source, index + 2, WORD_PART)
    : index + 1;
  return source.charAt(body) === '$' ? source.slice(index, body + 1) : undefined;
}

function scanComment(source: string, index: number, engine: SqlEngine): Scanned | undefined {
  if (source.startsWith('--', index)) {
    return token('comment', endOfLineComment(source, index));
  }
  return source.startsWith('/*', index)
    ? token('comment', endOfBlockComment(source, index, engine === 'postgres'))
    : undefined;
}

/**
`N'…'` on SQL Server (a national-character literal) and `E'…'` on PostgreSQL (backslash escapes).
*/
function scanPrefixedString(source: string, index: number, engine: SqlEngine): Scanned | undefined {
  if (source[index + 1] !== "'") {
    return undefined;
  }
  const prefix = source.charAt(index).toUpperCase();
  if (engine === 'mssql' && prefix === 'N') {
    return token('string', endOfDoubled(source, index + 1, "'"));
  }
  return engine === 'postgres' && prefix === 'E'
    ? token('string', endOfEscaped(source, index + 1))
    : undefined;
}

function scanString(source: string, index: number, _engine: SqlEngine): Scanned | undefined {
  return source[index] === "'" ? token('string', endOfDoubled(source, index, "'")) : undefined;
}

function scanDollarString(source: string, index: number, engine: SqlEngine): Scanned | undefined {
  const tag = engine === 'postgres' ? dollarTag(source, index) : undefined;
  return tag === undefined ? undefined : token('string', endOfDollarString(source, index, tag));
}

function scanQuoted(source: string, index: number, engine: SqlEngine): Scanned | undefined {
  if (source[index] === '"') {
    return token('quoted', endOfDoubled(source, index, '"'));
  }
  return engine === 'mssql' && source[index] === '['
    ? token('quoted', endOfDoubled(source, index, ']'))
    : undefined;
}

/**
`$n` on PostgreSQL and `@pn` on SQL Server; any other `@name` is a variable, not a placeholder.
*/
function scanPositional(source: string, index: number): Scanned | undefined {
  const end = source[index] === '$' ? runOf(source, index + 1, DIGIT) : index + 1;
  return end > index + 1 ? placeholder(end, Number(source.slice(index + 1, end))) : undefined;
}

function scanVariable(source: string, index: number): Scanned | undefined {
  if (source[index] !== '@' || !WORD_START.test(source.charAt(index + 1))) {
    return undefined;
  }
  const end = runOf(source, index + 2, WORD_PART);
  const text = source.slice(index, end);
  return PARAMETER.test(text) ? placeholder(end, Number(text.slice(2))) : token('other', end);
}

function scanPlaceholder(source: string, index: number, engine: SqlEngine): Scanned | undefined {
  return engine === 'postgres' ? scanPositional(source, index) : scanVariable(source, index);
}

const SCANNERS = [
  scanComment,
  scanPrefixedString,
  scanString,
  scanDollarString,
  scanPlaceholder,
  scanQuoted,
] as const;

function scanToken(source: string, index: number, engine: SqlEngine): Scanned {
  for (const scan of SCANNERS) {
    const scanned = scan(source, index, engine);
    if (scanned !== undefined) {
      return scanned;
    }
  }
  if (source[index] === ';') {
    return token('semicolon', index + 1);
  }
  return WORD_START.test(source.charAt(index))
    ? token('word', runOf(source, index + 1, WORD_PART))
    : token('other', index + 1);
}

/**
Every token of one statement, whitespace dropped; each scanner consumes at least one character.
*/
export function tokenise(statement: string, engine: SqlEngine): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < statement.length) {
    const space = runOf(statement, index, SPACE);
    if (space > index) {
      index = space;
      continue;
    }
    const scanned = scanToken(statement, index, engine);
    tokens.push({ ...scanned, text: statement.slice(index, scanned.end) });
    index = scanned.end;
  }
  return tokens;
}
