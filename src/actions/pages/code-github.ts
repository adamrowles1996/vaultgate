/**
 * GitHub as the operator pages reach it (ACT-119, ACT-120): the repositories
 * a token can read, offered beside the repository field, and the repository
 * itself for a check. These are the only places a page uses a secret. The
 * token is read from the vault only inside the ID-15 window, at the moment
 * of the request, and sent to `api.github.com` only, resolved and pinned as
 * a call's destination is (ACT-55 to ACT-57, `internal` false); it is never
 * drawn, logged or put in a response, and a failure is shown by its code.
 * A page never opens an archive, so nothing here reaches the archive host.
 */
import { ok } from '../../result.ts';
import { isFieldPresent, parseFieldSelector } from '../../vault/fields.ts';
import {
  listRepos,
  type ListedRepo,
  repoInfo,
  type RepoInfo,
  type GitHubAccess,
} from '../connectors/code/github.ts';
import {
  codeCredentialSchema,
  codeDestinationSchema,
  GITHUB_API_HOST,
} from '../connectors/code/schemas.ts';
import { pinEndpoint } from '../destination.ts';
import { createScrubber } from '../scrub.ts';

import { TOKEN_FIELD } from './code-form.ts';
import { NO_FIELD, type FormValues } from './form-values.ts';
import { type GitHubFailure, NO_OFFER, type RepoOffer } from './repo-source.ts';

import type { GitHubCheck } from './check-report.ts';
import type { ConnectorForm } from './descriptors.ts';
import type { ChosenItem } from './target-form.ts';
import type { Lookup } from '../../net/ip-ranges.ts';
import type { PinnedFetch } from '../../net/pinned-https.ts';
import type { Result } from '../../result.ts';
import type { ItemSummary, VaultClient } from '../../vault/client.ts';
import type { ActionError } from '../errors.ts';

/**
What the pages need to reach GitHub: the pinned transport, the resolver and vaultgate's User-Agent.
*/
export interface GitHubPagesAccess {
  readonly fetch: PinnedFetch;
  readonly lookup: Lookup;
  readonly userAgent: string;
}

interface Dependencies {
  readonly github: GitHubPagesAccess;
  readonly vault: Pick<VaultClient, 'getItem' | 'getSecret'>;
}

/**
A value, or why GitHub was not asked or did not answer.
*/
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GitHubFailure };

function answered<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function refused(code: string, status?: number): Outcome<never> {
  return { ok: false, failure: status === undefined ? { code } : { code, status } };
}

const GITHUB_TIMEOUT_MS = 10_000;

/**
The schema's default token field, which an empty picker means.
*/
const DEFAULT_TOKEN_FIELD = 'password';

function ignoreCapture(): void {
  // A page opens no archive, so no redirect ever hands it a value to keep.
}

/**
 * One GitHub exchange from a page: the pinned API address and the token. A
 * page never opens an archive, so it has no archive address and nothing a
 * redirect could hand back is kept; what GitHub says is scrubbed of the
 * token before a page draws it (ACT-51).
 */
export function pageAccess(
  github: GitHubPagesAccess,
  apiAddress: string,
  token: string | undefined,
): GitHubAccess {
  const scrubber = createScrubber(
    token === undefined ? [] : [{ field: 'token', value: Buffer.from(token, 'utf8') }],
    undefined,
  );
  return {
    fetch: github.fetch,
    apiAddress,
    archiveAddress: '',
    token,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    userAgent: github.userAgent,
    capture: ignoreCapture,
    scrub: (text) => scrubber.text(text),
  };
}

/**
ACT-119: the token's repositories, each name scrubbed before a page draws it.
*/
async function scrubbedList(
  access: GitHubAccess,
): Promise<Result<readonly ListedRepo[], ActionError>> {
  const listed = await listRepos(access);
  return listed.ok
    ? ok(listed.value.map((repo) => ({ ...repo, fullName: access.scrub(repo.fullName) })))
    : listed;
}

/**
ACT-120: the repository as the token sees it, every text scrubbed before a page draws it.
*/
async function scrubbedInfo(
  access: GitHubAccess,
  repo: string,
): Promise<Result<RepoInfo, ActionError>> {
  const info = await repoInfo(access, repo);
  if (!info.ok) {
    return info;
  }
  const { fullName, defaultBranch, visibility } = info.value;
  return ok({
    fullName: access.scrub(fullName),
    defaultBranch: access.scrub(defaultBranch),
    visibility: access.scrub(visibility),
  });
}

/**
The token field a form names: `null` for no token, the schema's default when left empty.
*/
function chosenTokenField(values: FormValues): string | null {
  const raw = (values.get(TOKEN_FIELD) ?? '').trim();
  if (raw === NO_FIELD) {
    return null;
  }
  return raw === '' ? DEFAULT_TOKEN_FIELD : raw;
}

/**
The token, read now; only a secret field the item carries is read, and only its value is kept.
*/
async function tokenOf(
  vault: Dependencies['vault'],
  item: ItemSummary,
  tokenField: string,
): Promise<Outcome<string>> {
  const selector = parseFieldSelector(tokenField);
  if (selector === undefined || selector.kind === 'username') {
    return refused('invalid_selector');
  }
  if (!isFieldPresent(item, selector)) {
    return refused('field_not_on_item');
  }
  const secret = await vault.getSecret(item.id, selector);
  if (!secret.ok) {
    return refused(secret.error.code);
  }
  return answered(secret.value.kind === 'text' ? secret.value.value : secret.value.code);
}

function fromGitHub<T>(result: Result<T, ActionError>): Outcome<T> {
  if (result.ok) {
    return answered(result.value);
  }
  const status = result.error.detail?.['status'];
  return refused(result.error.code, typeof status === 'number' ? status : undefined);
}

/**
 * One exchange with GitHub under the token of `tokenField` on `item`, or
 * without one for `null`: `api.github.com` is resolved and pinned first, so
 * a refused address reads no secret, then the token is read and used at once.
 */
async function askGitHub<T>(
  dependencies: Dependencies,
  source: { readonly item: ItemSummary | undefined; readonly tokenField: string | null },
  work: (access: GitHubAccess) => Promise<Result<T, ActionError>>,
): Promise<Outcome<T>> {
  const endpoint = { host: GITHUB_API_HOST, tls: true };
  const pinned = await pinEndpoint(endpoint, false, dependencies.github.lookup);
  if (!pinned.ok) {
    const code =
      pinned.error.problem === 'unresolved' ? 'connection_failed' : 'destination_refused';
    return refused(code);
  }
  let token: string | undefined;
  if (source.tokenField !== null) {
    if (source.item === undefined) {
      return refused('not_found');
    }
    const fetched = await tokenOf(dependencies.vault, source.item, source.tokenField);
    if (!fetched.ok) {
      return fetched;
    }
    token = fetched.value;
  }
  return fromGitHub(await work(pageAccess(dependencies.github, pinned.value.address, token)));
}

export interface OfferRequest {
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly item: ChosenItem;
  readonly isReauthenticated: boolean;
}

/**
ACT-119: every repository the chosen token can read, for a code form inside the ID-15 window.
*/
export async function repoOffer(
  dependencies: Dependencies,
  request: OfferRequest,
): Promise<RepoOffer> {
  const { form, values, item } = request;
  if (form.kind !== 'code' || item.state !== 'found' || !request.isReauthenticated) {
    return NO_OFFER;
  }
  const tokenField = chosenTokenField(values);
  if (tokenField === null) {
    return { state: 'no-token' };
  }
  const source = { item: item.summary, tokenField };
  const listed = await askGitHub(dependencies, source, (access) => scrubbedList(access));
  return listed.ok
    ? { state: 'listed', repositories: listed.value }
    : { state: 'failed', failure: listed.failure };
}

export interface CheckRequest {
  readonly connector: string;
  readonly destination: unknown;
  readonly credential: { readonly item_id: string; readonly mapping: unknown };
  readonly isReauthenticated: boolean;
}

/**
 * ACT-120: whether the chosen token can read the repository, with its default
 * branch and visibility. A public repository answers without a token. Only a
 * code target is asked about, only inside the ID-15 window, and only once its
 * repository and token field are valid.
 */
export async function githubCheck(
  dependencies: Dependencies,
  request: CheckRequest,
): Promise<GitHubCheck | undefined> {
  if (request.connector !== 'code') {
    return undefined;
  }
  if (!request.isReauthenticated) {
    return { state: 'locked' };
  }
  const destination = codeDestinationSchema.safeParse(request.destination);
  const credential = codeCredentialSchema.safeParse(request.credential.mapping);
  if (!destination.success || !credential.success) {
    return { state: 'invalid' };
  }
  const tokenField = credential.data.token_field;
  const itemId = request.credential.item_id;
  const item = tokenField === null ? undefined : await dependencies.vault.getItem(itemId);
  const source = { item: item?.ok === true ? item.value : undefined, tokenField };
  const hasToken = tokenField !== null;
  const info = await askGitHub(dependencies, source, (access) =>
    scrubbedInfo(access, destination.data.repository),
  );
  return info.ok
    ? { state: 'read', repository: info.value, hasToken }
    : { state: 'failed', failure: info.failure, hasToken };
}
