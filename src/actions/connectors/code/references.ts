/**
 * The repository and ref grammar of the `code` connector (spec 14.8,
 * ACT-104, ACT-110). A repository is `owner/name` as GitHub spells it; a ref
 * is a branch or tag name, a full commit SHA, or, from a call only,
 * `pr:<number>`. Nothing here reaches the network: these rules decide what
 * may be put into a GitHub API path at all.
 */

const REPOSITORY_PART = /^[\w.-]{1,100}$/u;
const COMMIT_SHA = /^[\da-f]{40}$/u;
const REF_NAME = /^[\w./-]{1,255}$/u;
const PULL_REQUEST = /^pr:([1-9]\d{0,8})$/u;
const REPO_RULE = 'must be owner/name, each of letters, digits, ".", "_" or "-"';

export type ReferenceSpec =
  | { readonly kind: 'default' }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'pull'; readonly number: number };

/**
Why `owner/name` is refused, or `undefined`; neither part may be `.` or `..`.
*/
export function repoProblem(text: string): string | undefined {
  const parts = text.split('/');
  const isValid =
    parts.length === 2 &&
    parts.every((part) => REPOSITORY_PART.test(part) && part !== '.' && part !== '..');
  return isValid ? undefined : REPO_RULE;
}

/**
A branch or tag name: no `..` segment, no leading or trailing `/`, no empty segment.
*/
function isReferenceName(text: string): boolean {
  return (
    REF_NAME.test(text) &&
    !text.startsWith('/') &&
    !text.endsWith('/') &&
    text.split('/').every((segment) => segment !== '' && segment !== '..')
  );
}

export function isCommitSha(text: string): boolean {
  return COMMIT_SHA.test(text);
}

/**
Why a configured ref (never `pr:`) is refused, or `undefined`.
*/
export function configuredReferenceProblem(text: string): string | undefined {
  return isCommitSha(text) || isReferenceName(text)
    ? undefined
    : 'must be a branch or tag name, or a full 40-character commit SHA';
}

/**
A ref as a call or a destination names it, or `undefined` when it follows no rule of ACT-104.
*/
export function parseReference(text: string | undefined): ReferenceSpec | undefined {
  if (text === undefined) {
    return { kind: 'default' };
  }
  const pull = PULL_REQUEST.exec(text);
  if (pull !== null) {
    return { kind: 'pull', number: Number(pull[1]) };
  }
  if (isCommitSha(text)) {
    return { kind: 'commit', sha: text };
  }
  return isReferenceName(text) ? { kind: 'name', name: text } : undefined;
}

/**
Each path segment percent-encoded, the separators kept, for a GitHub API path.
*/
export function encodePath(text: string): string {
  return text
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
