/**
 * Bitwarden CLI version policy (VAULT-2, COMPAT-1).
 *
 * `MINIMUM_BW_VERSION` is the oldest release whose `bw serve` API matches
 * the schemas in `types.ts`; anything older is refused at start-up. The
 * release baked into the container image and fetched by `install.sh` is
 * pinned in those two files; `versions.test.ts` keeps them equal and at or
 * above the minimum.
 */
export const MINIMUM_BW_VERSION = '2025.1.0';

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_PATTERN = /^\s*v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/;

/**
Reads the leading `major.minor.patch` of `bw --version` output; `undefined` when absent.
*/
export function parseVersion(text: string): SemanticVersion | undefined {
  const groups = VERSION_PATTERN.exec(text)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return {
    major: Number(groups['major']),
    minor: Number(groups['minor']),
    patch: Number(groups['patch']),
  };
}

export function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function formatVersion(version: SemanticVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
