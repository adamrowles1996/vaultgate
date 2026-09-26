import { describe, expect, it } from 'vitest';

import {
  configuredReferenceProblem,
  encodePath,
  isCommitSha,
  parseReference,
  repoProblem,
} from './references.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('the repository grammar', () => {
  it('14.8 accepts owner/name of letters, digits, ".", "_" and "-", each part at most 100 characters', () => {
    expect(repoProblem('acme/widgets')).toBeUndefined();
    expect(repoProblem('Acme-Corp/widgets.js_2')).toBeUndefined();
    expect(repoProblem(`${'a'.repeat(100)}/${'b'.repeat(100)}`)).toBeUndefined();
  });

  it('14.8 refuses a repository that is not exactly two valid parts, or names "." or ".."', () => {
    const refused = [
      'widgets',
      'acme/widgets/extra',
      '/widgets',
      'acme/',
      './widgets',
      'acme/..',
      'acme/wid gets',
      'acme/wid%67ets',
      `acme/${'b'.repeat(101)}`,
      'acme/widgets?x=1',
    ];
    expect(refused.map((text) => repoProblem(text))).toStrictEqual(
      refused.map(() => 'must be owner/name, each of letters, digits, ".", "_" or "-"'),
    );
  });
});

describe('the ref grammar', () => {
  it('ACT-104 reads a branch or tag name, a full SHA and pr:<n>, and no ref at all as the default branch', () => {
    expect(parseReference(undefined)).toStrictEqual({ kind: 'default' });
    expect(parseReference('main')).toStrictEqual({ kind: 'name', name: 'main' });
    expect(parseReference('release/2026.09')).toStrictEqual({
      kind: 'name',
      name: 'release/2026.09',
    });
    expect(parseReference(SHA)).toStrictEqual({ kind: 'commit', sha: SHA });
    expect(parseReference('pr:7')).toStrictEqual({ kind: 'pull', number: 7 });
    expect(parseReference('pr:123456789')).toStrictEqual({ kind: 'pull', number: 123_456_789 });
  });

  it('ACT-104 refuses a ".." or empty segment, a leading or trailing "/", characters outside the grammar and more than 255 characters', () => {
    const refused = [
      '',
      '..',
      'a/../b',
      'feature/..',
      '/main',
      'main/',
      'a//b',
      'main branch',
      'main~1',
      'main^',
      'refs:heads',
      'a%2fb',
      'x'.repeat(256),
    ];
    expect(refused.filter((text) => parseReference(text) !== undefined)).toStrictEqual([]);
    expect(parseReference('x'.repeat(255))).toStrictEqual({ kind: 'name', name: 'x'.repeat(255) });
  });

  it('ACT-104 takes pr:<n> only for a positive number of at most nine digits', () => {
    const refused = ['pr:0', 'pr:01', 'pr:-1', 'pr:', 'pr:1234567890', 'PR:7'];
    expect(refused.filter((text) => parseReference(text) !== undefined)).toStrictEqual([]);
  });

  it('ACT-104 treats only 40 lower-case hex digits as a commit; anything else is a name', () => {
    expect(isCommitSha(SHA)).toBe(true);
    expect(isCommitSha(SHA.toUpperCase())).toBe(false);
    expect(isCommitSha(SHA.slice(1))).toBe(false);
    expect(parseReference(SHA.toUpperCase())).toStrictEqual({
      kind: 'name',
      name: SHA.toUpperCase(),
    });
  });

  it('14.8 a configured ref is a branch, a tag or a SHA; pr:<n> is for a call only', () => {
    expect(configuredReferenceProblem('main')).toBeUndefined();
    expect(configuredReferenceProblem(SHA)).toBeUndefined();
    expect(configuredReferenceProblem('pr:7')).toBe(
      'must be a branch or tag name, or a full 40-character commit SHA',
    );
    expect(configuredReferenceProblem('a/../b')).toBe(
      'must be a branch or tag name, or a full 40-character commit SHA',
    );
  });
});

describe('path encoding', () => {
  it('ACT-104 percent-encodes each segment of a ref and keeps the separators', () => {
    expect(encodePath('release/2026.09')).toBe('release/2026.09');
    expect(encodePath('refs/pull/7/head')).toBe('refs/pull/7/head');
    expect(encodePath('weird #branch?/ü')).toBe('weird%20%23branch%3F/%C3%BC');
  });
});
