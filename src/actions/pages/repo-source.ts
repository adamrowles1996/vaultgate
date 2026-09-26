/**
 * The repository a Semble connection takes from its token's own list
 * (ACT-119), offered beside the repository field the way ACT-2 offers the
 * vault item's addresses: every `owner/name` the chosen token can read,
 * listed on the server inside the ID-15 window when the operator presses
 * Check without saving (`code-github.ts`), or the code of the reason it
 * could not be listed. A form drawn any other way reads no secret and says
 * how to have the list. The choice is copied into the
 * field when the connection is saved; a typed `owner/name` works as well,
 * and a typed one that differs from the chosen one is refused rather than
 * resolved silently.
 */
import { EMPTY, type Html, html, when } from '../../identity/pages/template.ts';

import { type AppliedAddress, applyAddress } from './address-source.ts';
import { fieldName, type FormValues } from './form-values.ts';

import type { ConnectorForm, FieldDescriptor } from './descriptors.ts';
import type { ListedRepo } from '../connectors/code/github.ts';

export const REPOSITORY_FROM_FIELD = 'repository_from';

/**
What the form can offer beside the repository field.
*/
export type RepoOffer =
  | { readonly state: 'listed'; readonly repositories: readonly ListedRepo[] }
  | { readonly state: 'failed'; readonly failure: GitHubFailure }
  | { readonly state: 'no-token' }
  | { readonly state: 'on-check' }
  | { readonly state: 'none' };

export const NO_OFFER: RepoOffer = { state: 'none' };

/**
ACT-119: what a code form says beside the repository field until the operator checks it.
*/
const ON_CHECK =
  'Choose the token field and press Check without saving to list the repositories it can read.';

/**
Why GitHub was not asked or did not answer: an error code, and GitHub's status when it gave one.
*/
export interface GitHubFailure {
  readonly code: string;
  readonly status?: number;
}

const REASONS: Readonly<Record<string, string>> = {
  'upstream_error:404': 'GitHub has no such repository, or the token cannot read it',
  authentication_failed: 'GitHub refused the token',
  upstream_error: 'GitHub answered with an error',
  connection_failed: 'GitHub could not be reached',
  destination_refused: 'api.github.com resolved to an address vaultgate refuses',
  timeout: 'GitHub did not answer in time',
  tls_error: 'GitHub’s certificate could not be verified',
  field_not_on_item: 'the vault item has no such field',
  invalid_selector: 'the token field names no vault field',
  not_found: 'the vault item is not there',
  vault_unavailable: 'the vault is not available',
  invalid_item: 'the vault could not read that field',
  vault_protocol_error: 'the vault answered out of shape',
};

/**
A failure in words, with its code (and GitHub's status) after it; never a value from the vault.
*/
export function describeFailure(failure: GitHubFailure): string {
  const { code, status } = failure;
  const keyed = status === undefined ? undefined : REASONS[`${code}:${String(status)}`];
  const sentence = keyed ?? (Object.hasOwn(REASONS, code) ? REASONS[code] : undefined);
  const suffix = status === undefined ? code : `${code}, HTTP ${String(status)}`;
  return sentence === undefined ? suffix : `${sentence} (${suffix})`;
}

/**
 * Whether the token's list is offered beside the field. The browser then
 * never insists on a typed value: the list may fill the field, and the list
 * of another token field appears only once the form comes back from a check,
 * which a `required` empty box would stop the browser from sending.
 */
export function isOffered(field: FieldDescriptor): boolean {
  return field.kind === 'text' && field.offered === 'repositories';
}

function option(value: string, label: string, isSelected: boolean): Html {
  return html`<option value="${value}" ${when(isSelected, () => html`selected`)}>${label}</option>`;
}

function listed(repositories: readonly ListedRepo[], values: FormValues): Html {
  if (repositories.length === 0) {
    return html`<small class="warn"
      >GitHub lists no repository for this token; check its repository access, or type owner/name
      above.</small
    >`;
  }
  const chosen = values.get(REPOSITORY_FROM_FIELD) ?? '';
  const options = repositories.map((repo) =>
    option(
      repo.fullName,
      `${repo.fullName} · ${repo.isPrivate ? 'private' : 'public'}`,
      chosen === repo.fullName,
    ),
  );
  return html`<label
    >Or choose one the token can read
    <select name="${REPOSITORY_FROM_FIELD}">
      ${option('', 'No: use what is typed above', chosen === '')} ${options}
    </select>
    <small
      >${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} from
      GitHub, listed with the token just now. Copied when you save.</small
    >
  </label>`;
}

/**
ACT-119: the list beside the repository field, the reason there is none, or nothing.
*/
export function repoSource(field: FieldDescriptor, offer: RepoOffer, values: FormValues): Html {
  if (!isOffered(field)) {
    return EMPTY;
  }
  switch (offer.state) {
    case 'listed': {
      return listed(offer.repositories, values);
    }
    case 'failed': {
      return html`<small class="warn"
        >The token’s repositories could not be listed: ${describeFailure(offer.failure)}. Type
        owner/name above, or choose another token field.</small
      >`;
    }
    case 'no-token': {
      return html`<small>No token: type the public repository as owner/name.</small>`;
    }
    case 'on-check': {
      return html`<small>${ON_CHECK}</small>`;
    }
    case 'none': {
      return EMPTY;
    }
  }
}

function repoField(form: ConnectorForm): FieldDescriptor | undefined {
  return form.fields.find((field) => isOffered(field));
}

/**
 * The submitted values with the chosen repository copied in, or the problem
 * that stops the save. GitHub names repositories case-insensitively, so a
 * typed name that differs from the chosen one only in case is the same
 * repository, and the chosen spelling (GitHub's own) is kept.
 */
function applyRepo(form: ConnectorForm, values: FormValues): AppliedAddress {
  const chosen = (values.get(REPOSITORY_FROM_FIELD) ?? '').trim();
  const field = repoField(form);
  if (chosen === '' || field === undefined) {
    return { values, problems: [] };
  }
  const name = fieldName(field);
  const typed = (values.get(name) ?? '').trim();
  return typed === '' || typed.toLowerCase() === chosen.toLowerCase()
    ? { values: new Map([...values, [name, chosen]]), problems: [] }
    : {
        values,
        problems: [
          `${name}: a repository is typed here and another is chosen from the token’s list; keep one of them`,
        ],
      };
}

/**
ACT-2, ACT-119: what the form takes from beside its fields, the item's address and the token's repository.
*/
export function applyChoices(form: ConnectorForm, submitted: FormValues): AppliedAddress {
  const address = applyAddress(form, submitted);
  const repo = applyRepo(form, address.values);
  return { values: repo.values, problems: [...address.problems, ...repo.problems] };
}
