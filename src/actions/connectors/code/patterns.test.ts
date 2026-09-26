import { describe, expect, it } from 'vitest';

import { MAX_PATTERN_BYTES, patternBytes, patternProblem } from './patterns.ts';
import { codePolicySchema } from './schemas.ts';
import { encodeBuildSpec } from './sidecar.ts';

import type { BuildSpec } from './sidecar-schemas.ts';

const GIB = 1024 * 1024 * 1024;
/**
The sidecar's own ceilings for a build spec (`sidecars/code/PROTOCOL.md`).
*/
const SIDECAR_CEILINGS = {
  max_archive_bytes: GIB,
  max_files: 200_000,
  max_total_bytes: 4 * GIB,
  max_file_bytes: 64 * 1024 * 1024,
  build_timeout_s: 3600,
} as const;
const HEADER_LINE_LIMIT = 64 * 1024;

function isAccepted(overrides: Readonly<Record<string, unknown>>): boolean {
  return codePolicySchema.safeParse(overrides).success;
}

/**
Patterns of `character` whose JSON, as the build spec carries it, takes (up to) `bytes` bytes.
*/
function filling(bytes: number, character = 'a'): string[] {
  const weight = Buffer.byteLength(JSON.stringify(character)) - 2;
  const patterns: string[] = [];
  let used = 2;
  let room = Math.floor((bytes - used - 2) / weight);
  while (room >= 1) {
    const length = Math.min(1024, room);
    used += (patterns.length === 0 ? 2 : 3) + length * weight;
    patterns.push(character.repeat(length));
    room = Math.floor((bytes - used - 3) / weight);
  }
  return patterns;
}

describe('the include and exclude patterns (ACT-106, PROTOCOL.md)', () => {
  it('ACT-106 a pattern is a single line: a line feed, a carriage return or a NUL is refused at policy validation', () => {
    expect(['a\nb', 'a\rb', 'a\0b'].map((pattern) => patternProblem(pattern))).toStrictEqual([
      'must be a single line',
      'must be a single line',
      'must be a single line',
    ]);
    expect(isAccepted({ include: ['src/\n*.ts'] })).toBe(false);
    expect(isAccepted({ exclude: ['vendor/\r'] })).toBe(false);
  });

  it('ACT-106 a pattern the sidecar cannot compile is refused: ! alone, a backwards range, a dangling backslash', () => {
    const refused = ['!', '[z-a]', 'x[!9-0]', 'log[b-a-z]', 'tail\\', 'tail\\\\\\'];
    expect(refused.map((pattern) => patternProblem(pattern))).toStrictEqual([
      'negates nothing',
      'has a character range that runs backwards',
      'has a character range that runs backwards',
      'has a character range that runs backwards',
      'ends with a backslash that escapes nothing',
      'ends with a backslash that escapes nothing',
    ]);
    expect(isAccepted({ exclude: ['[z-a]'] })).toBe(false);
  });

  it('ACT-106 gitignore patterns the sidecar compiles are accepted as they are', () => {
    const accepted = [
      '!keep.env',
      '[a-z]*.log',
      '[a-c-a]',
      '[]-a]',
      '[^a-z]',
      'unclosed[z-a',
      'escaped\\\\',
      String.raw`space\ `,
      '**/node_modules/',
      '#comment',
      'ü[à-é]',
    ];
    expect(accepted.filter((pattern) => patternProblem(pattern) !== undefined)).toStrictEqual([]);
    expect(isAccepted({ include: accepted, exclude: accepted })).toBe(true);
  });

  it('14.8 a pattern is 1 to 1 024 characters, at most 100 of each list', () => {
    expect(isAccepted({ include: ['x'.repeat(1024)] })).toBe(true);
    expect(isAccepted({ include: ['x'.repeat(1025)] })).toBe(false);
    expect(isAccepted({ exclude: [''] })).toBe(false);
  });
});

describe('the build spec header budget (PROTOCOL.md)', () => {
  it('ACT-106 include and exclude together hold at most 32 KiB as JSON', () => {
    const include = filling(MAX_PATTERN_BYTES / 2);
    const exclude = filling(MAX_PATTERN_BYTES / 2);
    expect(patternBytes(include, exclude)).toBe(MAX_PATTERN_BYTES);
    expect(isAccepted({ include, exclude })).toBe(true);
    const over = codePolicySchema.safeParse({
      include,
      exclude: [...exclude.slice(0, -1), `${exclude.at(-1) ?? ''}x`],
    });
    expect(
      over.success || over.error.issues.map((issue) => [issue.path, issue.message]),
    ).toStrictEqual([
      [['include'], 'include and exclude together must be at most 32 KiB, as JSON'],
    ]);
  });

  it('ACT-106 counts the budget as JSON, so quotes, backslashes and multi-byte characters count as the spec carries them', () => {
    expect(patternBytes(['"'], [])).toBe(8);
    expect(patternBytes([], ['\\\\'])).toBe(10);
    expect(patternBytes(['é'], ['x'])).toBe(11);
    const quoted = filling(MAX_PATTERN_BYTES, '"');
    expect(isAccepted({ include: quoted })).toBe(false);
    expect(isAccepted({ include: quoted.slice(0, quoted.length / 2) })).toBe(true);
  });

  it('ACT-106 the largest spec a policy allows encodes well inside the 64 KiB header line', () => {
    const policy = codePolicySchema.parse({
      include: filling(MAX_PATTERN_BYTES / 2, 'é'),
      exclude: filling(MAX_PATTERN_BYTES / 2, 'é'),
      max_archive_bytes: GIB,
      max_files: 200_000,
      max_total_bytes: 4 * GIB,
      max_file_bytes: 16 * 1024 * 1024,
      build_timeout_s: 3600,
    });
    const spec: BuildSpec = {
      owner: 'f'.repeat(64),
      commit: 'a'.repeat(40),
      include: policy.include,
      exclude: policy.exclude,
      max_archive_bytes: policy.max_archive_bytes,
      max_files: policy.max_files,
      max_total_bytes: policy.max_total_bytes,
      max_file_bytes: policy.max_file_bytes,
      build_timeout_s: policy.build_timeout_s,
      variants: [['code', 'docs', 'config'], ['code'], ['docs'], ['config']],
    };
    const line = `x-vaultgate-build: ${encodeBuildSpec(spec)}\r\n`;
    expect(Buffer.byteLength(line)).toBeLessThan(48 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThan(HEADER_LINE_LIMIT);
  });

  it('14.8 no policy ceiling exceeds what the sidecar accepts in a build spec', () => {
    const past = Object.entries(SIDECAR_CEILINGS).map(([field, ceiling]) => [
      field,
      isAccepted({ [field]: ceiling + 1 }),
    ]);
    expect(past).toStrictEqual(Object.keys(SIDECAR_CEILINGS).map((field) => [field, false]));
  });
});
