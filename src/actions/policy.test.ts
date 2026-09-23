import { describe, expect, it } from 'vitest';

import {
  commandPatternProblem,
  commonPolicySchema,
  httpSubject,
  isPatternMatch,
} from './policy.ts';

describe('isPatternMatch', () => {
  it('ACT-34 a single star does not cross a slash', () => {
    expect(isPatternMatch('/v1/*', '/v1/users', 'path')).toBe(true);
    expect(isPatternMatch('/v1/*', '/v1/users/1', 'path')).toBe(false);
    expect(isPatternMatch('/v1/*/posts', '/v1/u/posts', 'path')).toBe(true);
    expect(isPatternMatch('/v1/*/posts', '/v1/u/x/posts', 'path')).toBe(false);
    expect(isPatternMatch('/*.json', '/a/b.json', 'path')).toBe(false);
  });

  it('ACT-34 a double star crosses slashes, for paths only', () => {
    expect(isPatternMatch('/**', '/', 'path')).toBe(true);
    expect(isPatternMatch('/**', '/a/b/c?x=1', 'path')).toBe(true);
    expect(isPatternMatch('/v1/**/end', '/v1/a/b/end', 'path')).toBe(true);
    expect(isPatternMatch('/v1/**/end', '/v1/end', 'path')).toBe(false);
    expect(isPatternMatch('/**/x', '/a/x/b/x', 'path')).toBe(true);
    expect(isPatternMatch('ls **', 'ls a/b', 'command')).toBe(true);
    expect(isPatternMatch('ls **', 'ls a\nb', 'command')).toBe(false);
  });

  it('ACT-34 is anchored at both ends and case-sensitive', () => {
    expect(isPatternMatch('/users', '/users', 'path')).toBe(true);
    expect(isPatternMatch('/users', '/users/1', 'path')).toBe(false);
    expect(isPatternMatch('users', '/users', 'path')).toBe(false);
    expect(isPatternMatch('/Users', '/users', 'path')).toBe(false);
    expect(isPatternMatch('', '', 'path')).toBe(true);
    expect(isPatternMatch('*', '', 'path')).toBe(true);
  });

  it('ACT-34 a star in a command stops at a newline and every other character is literal', () => {
    expect(isPatternMatch('uptime *', 'uptime -p', 'command')).toBe(true);
    expect(isPatternMatch('uptime *', 'uptime -p\nrm -rf /', 'command')).toBe(false);
    expect(isPatternMatch('uptime *', 'uptime a/b', 'command')).toBe(true);
    expect(isPatternMatch('a.b', 'axb', 'command')).toBe(false);
    expect(isPatternMatch('a[b](c)+d', 'a[b](c)+d', 'command')).toBe(true);
    expect(isPatternMatch(String.raw`a\b`, String.raw`a\b`, 'command')).toBe(true);
  });

  it('ACT-34 considers every placement of a literal after a wildcard, not only the first', () => {
    expect(isPatternMatch('/*.json', '/a.json', 'path')).toBe(true);
    expect(isPatternMatch('/*.json', '/a.json.bak', 'path')).toBe(false);
    expect(isPatternMatch('/*-*', '/a-b-c', 'path')).toBe(true);
    expect(isPatternMatch('/*-x', '/a-b-x', 'path')).toBe(true);
    expect(isPatternMatch('/**-x', '/a-b-x', 'path')).toBe(true);
    expect(isPatternMatch('/**x*y', '/x/xy', 'path')).toBe(true);
    expect(isPatternMatch('/**x*y', '/x/x/y', 'path')).toBe(false);
    expect(isPatternMatch('/a*', '/b', 'path')).toBe(false);
    expect(isPatternMatch('/a', '/ab', 'path')).toBe(false);
  });

  it('ACT-34 matches a long adversarial subject in linear time, so a pattern cannot cause ReDoS', () => {
    const subject = `/${'a'.repeat(20_000)}`;
    const started = performance.now();
    expect(isPatternMatch(`/${'*a'.repeat(40)}*x*a`, `${subject}b`, 'path')).toBe(false);
    expect(isPatternMatch(`/${'a*'.repeat(40)}`, subject, 'path')).toBe(true);
    expect(isPatternMatch(`/${'*a'.repeat(40)}*`, `${subject}/`, 'path')).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('commandPatternProblem', () => {
  it('ACT-35 refuses a command pattern that would allow every command unless any_command is meant', () => {
    expect(commandPatternProblem(['uptime', '*'], false)).toBe(
      'the command pattern "*" would allow every command; set any_command instead',
    );
    expect(commandPatternProblem(['**'], false)).toBe(
      'the command pattern "**" would allow every command; set any_command instead',
    );
    expect(commandPatternProblem(['*'], true)).toBeUndefined();
    expect(commandPatternProblem(['uptime *', 'df -h', ''], false)).toBeUndefined();
    expect(commandPatternProblem([], false)).toBeUndefined();
  });
});

describe('httpSubject', () => {
  it('ACT-35 decodes percent-encoded unreserved characters and upper-cases every other escape', () => {
    expect(httpSubject('/%61%2Fb%2f%30')).toBe('/a%2Fb%2F0');
    expect(httpSubject('/%7E%2D%5F%2E%41%7a')).toBe('/~-_.Az');
    expect(httpSubject('/a%zz%4')).toBe('/a%zz%4');
    expect(httpSubject('/%C3%BC')).toBe('/%C3%BC');
  });

  it('ACT-35 removes dot segments and keeps the query, decoded the same way', () => {
    expect(httpSubject('/a/./b/../c?x=%41&y=%2F')).toBe('/a/c?x=A&y=%2F');
    expect(httpSubject('/a/b/.')).toBe('/a/b/');
    expect(httpSubject('/a/b/..')).toBe('/a/');
    expect(httpSubject('/a//b')).toBe('/a//b');
    expect(httpSubject('/')).toBe('/');
  });

  it('ACT-20 ACT-35 refuses a path that does not start with a slash or climbs above base_url, even percent-encoded', () => {
    expect(httpSubject('a/b')).toBeUndefined();
    expect(httpSubject('/..')).toBeUndefined();
    expect(httpSubject('/../etc')).toBeUndefined();
    expect(httpSubject('/a/%2e%2e/%2E%2E/x')).toBeUndefined();
    expect(httpSubject('/a/../b')).toBe('/b');
  });
});

describe('commonPolicySchema', () => {
  it('ACT-1 applies the defaults and ceilings of 13.11 to the common policy fields', () => {
    expect(commonPolicySchema.parse({})).toStrictEqual({
      timeout_ms: 30_000,
      max_output_bytes: 262_144,
      rate_limit_per_minute: 60,
      confirm_writes: false,
    });
    expect(
      commonPolicySchema.parse({
        timeout_ms: 300_000,
        max_output_bytes: 1_048_576,
        rate_limit_per_minute: 600,
        confirm_writes: true,
        allowed_paths: ['/**'],
      }),
    ).toStrictEqual({
      timeout_ms: 300_000,
      max_output_bytes: 1_048_576,
      rate_limit_per_minute: 600,
      confirm_writes: true,
    });
    const invalid = [
      { timeout_ms: 300_001 },
      { timeout_ms: 999 },
      { max_output_bytes: 1_048_577 },
      { max_output_bytes: 1023 },
      { rate_limit_per_minute: 0 },
      { rate_limit_per_minute: 601 },
      { confirm_writes: 'yes' },
    ];
    expect(invalid.map((policy) => commonPolicySchema.safeParse(policy).success)).toStrictEqual(
      invalid.map(() => false),
    );
  });
});
