import { describe, expect, it } from 'vitest';

import {
  type CodeDocuments,
  extractionFingerprint,
  parseSnapshotKey,
  resetFingerprint,
  snapshotKey,
} from './keys.ts';
import { codeCredentialSchema, codeDestinationSchema, codePolicySchema } from './schemas.ts';

const SHA = 'a'.repeat(40);
const TARGET_ID = '3f0c9a52-6b1e-4d2a-9c7f-0e4b8d6a1f25';

function documents(
  overrides: {
    readonly destination?: Readonly<Record<string, unknown>>;
    readonly credential?: Readonly<Record<string, unknown>>;
    readonly policy?: Readonly<Record<string, unknown>>;
  } = {},
): CodeDocuments {
  return {
    destination: codeDestinationSchema.parse({
      repository: 'acme/widgets',
      ...overrides.destination,
    }),
    credential: codeCredentialSchema.parse({ ...overrides.credential }),
    policy: codePolicySchema.parse({ ...overrides.policy }),
  };
}

const EXTRACTION_CHANGES = [
  { destination: { repository: 'acme/gadgets' } },
  { credential: { token_field: 'custom.github' } },
  { credential: { token_field: null } },
  { policy: { include: ['src/'] } },
  { policy: { exclude: ['vendor/'] } },
  { policy: { max_archive_bytes: 2 * 1024 * 1024 } },
  { policy: { max_files: 10 } },
  { policy: { max_total_bytes: 2 * 1024 * 1024 } },
  { policy: { max_file_bytes: 4096 } },
];

const RESET_ONLY_CHANGES = [
  { destination: { ref: 'v1.0' } },
  { policy: { content: ['docs'] } },
  { policy: { build_timeout_s: 60 } },
];

const HARMLESS_CHANGES = [
  { policy: { max_top_k: 10 } },
  { policy: { allow_ref: false } },
  { policy: { allow_read: false } },
  { policy: { max_read_lines: 10 } },
  { policy: { build_wait_s: 30 } },
  { policy: { refresh_interval_s: 3600 } },
  { policy: { content: ['config', 'docs', 'code'] } },
  { destination: { repository: 'Acme/Widgets' } },
];

describe('snapshot keys', () => {
  it('ACT-107 a snapshot is one target at one commit under one extraction policy', () => {
    const fingerprint = extractionFingerprint(documents());
    expect(fingerprint).toMatch(/^[\da-f]{16}$/u);
    const key = snapshotKey(TARGET_ID, fingerprint, SHA);
    expect(key).toBe(`${TARGET_ID}.${fingerprint}.${SHA}`);
    expect(key).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
    expect(parseSnapshotKey(key)).toStrictEqual({ targetId: TARGET_ID, fingerprint, commit: SHA });
  });

  it('ACT-109 parses a key whose target id is any protocol owner, and nothing that is not a key', () => {
    const fingerprint = extractionFingerprint(documents());
    expect(parseSnapshotKey(`id-7.${fingerprint}.${SHA}`)?.targetId).toBe('id-7');
    const foreign = [
      'someone-else',
      `-id.${fingerprint}.${SHA}`,
      `ID-7.${fingerprint}.${SHA}`,
      `id-7.${fingerprint.slice(1)}.${SHA}`,
      `id-7.${fingerprint}.${SHA.slice(1)}`,
      `${'a'.repeat(65)}.${fingerprint}.${SHA}`,
    ];
    expect(foreign.filter((key) => parseSnapshotKey(key) !== undefined)).toStrictEqual([]);
  });

  it('ACT-106 ACT-109 the extraction fingerprint follows the repository, the token field, include, exclude and the extraction caps', () => {
    const base = extractionFingerprint(documents());
    expect(
      EXTRACTION_CHANGES.map((change) => extractionFingerprint(documents(change)) === base),
    ).toStrictEqual(EXTRACTION_CHANGES.map(() => false));
    expect(
      RESET_ONLY_CHANGES.map((change) => extractionFingerprint(documents(change)) === base),
    ).toStrictEqual(RESET_ONLY_CHANGES.map(() => true));
  });

  it('ACT-108 a revision of the destination, the token field, content, include, exclude or a cap resets; nothing else does', () => {
    const base = resetFingerprint(documents());
    const resets = [...EXTRACTION_CHANGES, ...RESET_ONLY_CHANGES];
    expect(resets.map((change) => resetFingerprint(documents(change)) === base)).toStrictEqual(
      resets.map(() => false),
    );
    expect(
      HARMLESS_CHANGES.map((change) => resetFingerprint(documents(change)) === base),
    ).toStrictEqual(HARMLESS_CHANGES.map(() => true));
  });
});
