import { describe, expect, it } from 'vitest';

import {
  codeCredentialSchema,
  codeDestinationSchema,
  type CodePolicy,
  codePolicySchema,
  codeSchemas,
  DEFAULT_EXCLUDE,
  normaliseContent,
} from './schemas.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function policy(overrides: Readonly<Record<string, unknown>> = {}): CodePolicy {
  return codePolicySchema.parse(overrides);
}

function documents(overrides: Readonly<Record<string, unknown>>) {
  return {
    destination: codeDestinationSchema.parse({ repository: 'acme/widgets' }),
    credential: codeCredentialSchema.parse({}),
    policy: policy(overrides),
  };
}

function isRefused(overrides: Readonly<Record<string, unknown>>): boolean {
  return !codePolicySchema.safeParse(overrides).success;
}

describe('code destination', () => {
  it('14.8 is a GitHub repository with an optional configured ref; the forge defaults to github', () => {
    expect(codeDestinationSchema.parse({ repository: 'acme/widgets' })).toStrictEqual({
      forge: 'github',
      repository: 'acme/widgets',
    });
    expect(codeDestinationSchema.parse({ repository: 'acme/widgets', ref: 'v1.0' }).ref).toBe(
      'v1.0',
    );
    expect(
      codeDestinationSchema.safeParse({ repository: 'acme/widgets', forge: 'gitlab' }).success,
    ).toBe(false);
    expect(codeDestinationSchema.safeParse({ repository: 'acme' }).success).toBe(false);
    expect(
      codeDestinationSchema.safeParse({ repository: 'acme/widgets', ref: 'pr:7' }).success,
    ).toBe(false);
    expect(
      codeDestinationSchema.safeParse({ repository: 'acme/widgets', url: 'https://x' }).success,
    ).toBe(false);
  });
});

describe('code credential', () => {
  it('ACT-103 names the token field, password by default, or null for a public repository', () => {
    expect(codeCredentialSchema.parse({})).toStrictEqual({ token_field: 'password' });
    expect(codeCredentialSchema.parse({ token_field: 'custom.github' })).toStrictEqual({
      token_field: 'custom.github',
    });
    expect(codeCredentialSchema.parse({ token_field: null })).toStrictEqual({ token_field: null });
    expect(codeCredentialSchema.safeParse({ token_field: '' }).success).toBe(false);
    expect(codeSchemas.credentialFields({ token_field: 'custom.github' })).toStrictEqual([
      { name: 'custom.github', selector: 'custom.github', role: 'secret' },
    ]);
    expect(codeSchemas.credentialFields({ token_field: null })).toStrictEqual([]);
  });
});

describe('code policy', () => {
  it('14.8 has the defaults of the policy table', () => {
    const defaults = policy();
    expect({
      timeout_ms: defaults.timeout_ms,
      refresh_interval_s: defaults.refresh_interval_s,
      content: defaults.content,
      allow_ref: defaults.allow_ref,
      max_top_k: defaults.max_top_k,
      build_wait_s: defaults.build_wait_s,
      include: defaults.include,
      max_archive_bytes: defaults.max_archive_bytes,
      max_files: defaults.max_files,
      max_total_bytes: defaults.max_total_bytes,
      max_file_bytes: defaults.max_file_bytes,
      build_timeout_s: defaults.build_timeout_s,
      allow_read: defaults.allow_read,
      max_read_lines: defaults.max_read_lines,
    }).toStrictEqual({
      timeout_ms: 150_000,
      refresh_interval_s: 300,
      content: ['code', 'docs', 'config'],
      allow_ref: true,
      max_top_k: 50,
      build_wait_s: 90,
      include: [],
      max_archive_bytes: 256 * MIB,
      max_files: 50_000,
      max_total_bytes: GIB,
      max_file_bytes: MIB,
      build_timeout_s: 600,
      allow_read: true,
      max_read_lines: 400,
    });
  });

  it('ACT-106 excludes the common secret-file names by default, and a replaced list replaces them', () => {
    expect(policy().exclude).toStrictEqual([
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
    ]);
    expect(DEFAULT_EXCLUDE).toStrictEqual(policy().exclude);
    expect(policy({ exclude: ['vendor/'] }).exclude).toStrictEqual(['vendor/']);
    expect(policy({ exclude: [] }).exclude).toStrictEqual([]);
  });

  it('14.8 holds every number to its range and every ceiling of the table', () => {
    const accepted = [
      { refresh_interval_s: 60 },
      { refresh_interval_s: 86_400 },
      { max_top_k: 200 },
      { build_wait_s: 0 },
      { build_wait_s: 290, timeout_ms: 300_000 },
      { max_archive_bytes: GIB },
      { max_files: 200_000 },
      { max_total_bytes: 4 * GIB },
      { max_file_bytes: 16 * MIB },
      { build_timeout_s: 3600 },
      { max_read_lines: 2000 },
    ];
    expect(accepted.map((overrides) => isRefused(overrides))).toStrictEqual(
      accepted.map(() => false),
    );
    const refused = [
      { refresh_interval_s: 59 },
      { refresh_interval_s: 86_401 },
      { max_top_k: 201 },
      { max_top_k: 0 },
      { build_wait_s: 291 },
      { build_wait_s: -1 },
      { max_archive_bytes: GIB + 1 },
      { max_files: 200_001 },
      { max_total_bytes: 4 * GIB + 1 },
      { max_file_bytes: 16 * MIB + 1 },
      { build_timeout_s: 3601 },
      { max_read_lines: 2001 },
      { max_read_lines: 0 },
      { timeout_ms: 300_001 },
      { max_top_k: 5.5 },
    ];
    expect(refused.map((overrides) => isRefused(overrides))).toStrictEqual(refused.map(() => true));
  });

  it('14.8 content is a non-empty subset of code, docs and config without repeats', () => {
    expect(policy({ content: ['docs'] }).content).toStrictEqual(['docs']);
    expect(isRefused({ content: [] })).toBe(true);
    expect(isRefused({ content: ['docs', 'docs'] })).toBe(true);
    expect(isRefused({ content: ['tests'] })).toBe(true);
    expect(isRefused({ content: 'all' })).toBe(true);
  });

  it('14.8 include and exclude hold at most 100 patterns of 1 to 1 024 characters', () => {
    const hundred = Array.from({ length: 100 }, (_value, index) => `dir${String(index)}/`);
    expect(policy({ include: hundred }).include).toHaveLength(100);
    expect(isRefused({ include: [...hundred, 'one-more/'] })).toBe(true);
    expect(isRefused({ exclude: [...hundred, 'one-more/'] })).toBe(true);
    expect(isRefused({ include: ['x'.repeat(1025)] })).toBe(true);
    expect(isRefused({ exclude: [''] })).toBe(true);
    expect(policy({ include: ['x'.repeat(1024)] }).include).toStrictEqual(['x'.repeat(1024)]);
  });

  it('ACT-112 refuses a build wait that does not end 10 seconds before the call timeout', () => {
    expect(codeSchemas.saveProblems(documents({}))).toStrictEqual([]);
    expect(codeSchemas.saveProblems(documents({ build_wait_s: 140 }))).toStrictEqual([]);
    expect(codeSchemas.saveProblems(documents({ build_wait_s: 141 }))).toStrictEqual([
      'policy.build_wait_s: must end at least 10 seconds before policy.timeout_ms',
    ]);
    expect(
      codeSchemas.saveProblems(documents({ build_wait_s: 20, timeout_ms: 29_999 })),
    ).toHaveLength(1);
  });
});

describe('code schemas', () => {
  it('ACT-103 names api.github.com and codeload.github.com, both over TLS', () => {
    expect(
      codeSchemas.endpoints(codeDestinationSchema.parse({ repository: 'acme/w' })),
    ).toStrictEqual([
      { host: 'api.github.com', tls: true },
      { host: 'codeload.github.com', tls: true },
    ]);
    expect(codeSchemas.internalRefused).toBe(
      'internal: a code target reaches GitHub over the internet and is never internal',
    );
  });

  it('ACT-43 ACT-49 summarises the repository and its ref, and no code call is ever a write', () => {
    const destination = codeDestinationSchema.parse({ repository: 'acme/widgets' });
    expect(codeSchemas.summariseDestination(destination)).toBe('acme/widgets');
    expect(codeSchemas.summariseDestination({ ...destination, ref: 'v1.0' })).toBe(
      'acme/widgets@v1.0',
    );
    expect(codeSchemas.allowsNonRead(policy())).toBe(false);
  });

  it('14.8.6 normalises a selection to code, docs, config order', () => {
    expect(normaliseContent(['config', 'code'])).toStrictEqual(['code', 'config']);
    expect(normaliseContent(['docs', 'config', 'code'])).toStrictEqual(['code', 'docs', 'config']);
  });
});
