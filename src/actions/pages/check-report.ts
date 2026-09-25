/**
 * What a check found, as the pages show it (ACT-118): each destination host
 * with the address a call would be pinned to or why it is refused, the vault
 * item and each field mapped from it (a secret one sealed), and every other
 * problem. Nothing here is secret: addresses, the item's name and field
 * names. A check saves nothing and connects to nothing, except that a code
 * target's asks GitHub whether its token can read the repository (ACT-120).
 */
import { icon } from '../../identity/pages/icons.ts';
import { EMPTY, type Html, html } from '../../identity/pages/template.ts';
import { cardHead, fieldChip, formatInstant, pill, sealed } from '../../identity/pages/ui.ts';

import { describeFailure, type GitHubFailure } from './repo-source.ts';

import type { RepoInfo } from '../connectors/code/github.ts';
import type { CheckReport, EndpointReport, FieldReport, ItemReport } from '../targets-checks.ts';

/**
ACT-120: what GitHub said about the repository, asked with the chosen token or with none.
*/
export type GitHubCheck =
  | { readonly state: 'read'; readonly repository: RepoInfo; readonly hasToken: boolean }
  | { readonly state: 'failed'; readonly failure: GitHubFailure; readonly hasToken: boolean }
  | { readonly state: 'locked' }
  | { readonly state: 'invalid' };

/**
What a check found and when, with GitHub's answer for a code target (ACT-120).
*/
export interface PageCheck {
  readonly report: CheckReport;
  readonly at: number;
  readonly github?: GitHubCheck | undefined;
}

/**
The submit button a form checks with, and the query that checks a saved computer.
*/
export const INTENT_FIELD = 'intent';
export const CHECK_INTENT = 'check';
export const CHECK_PARAM = 'check';
export const CHECK_NOW = 'now';

/**
A problem without the path that files it against a form control; the line already says what it is about.
*/
function withoutPath(problem: string): string {
  return problem.replace(/^[\w.]+: /u, '');
}

function line(isOk: boolean, body: Html): Html {
  return html`<li class="${isOk ? 'check-ok' : 'check-bad'}">
    ${icon(isOk ? 'check' : 'x')}<span>${body}</span>
  </li>`;
}

function problems(list: readonly string[]): Html {
  return html`${list.map((problem) => html` <span class="check-problem">${withoutPath(problem)}</span>`)}`;
}

function endpointLine(endpoint: EndpointReport): Html {
  const { address } = endpoint;
  const found =
    address === undefined
      ? html`is refused`
      : html`resolves to <span class="mono">${address}</span>`;
  const transport = endpoint.tls ? 'encrypted' : 'plain transport';
  return line(
    endpoint.problems.length === 0,
    html`<span class="mono">${endpoint.host}</span> ${found} · ${transport}
      ${problems(endpoint.problems)}`,
  );
}

function itemLine(item: ItemReport): Html {
  return item.found
    ? line(true, html`Vault item <strong>${item.name}</strong> is there`)
    : line(false, html`${withoutPath(item.problem)}`);
}

function fieldLine(field: FieldReport): Html {
  const chip = field.role === 'secret' ? sealed(field.selector) : fieldChip(field.selector);
  return field.problem === undefined
    ? line(true, html`${chip} is on the item`)
    : line(false, html`${chip} ${problems([field.problem])}`);
}

function skipped(body: Html): Html {
  return html`<li class="check-skip">${icon('info')}<span>${body}</span></li>`;
}

/**
ACT-120: GitHub's answer about the repository, never the token.
*/
function githubLine(github: GitHubCheck): Html {
  switch (github.state) {
    case 'read': {
      const { repository, hasToken } = github;
      const who = hasToken ? 'The token can read' : 'GitHub answers without a token for';
      return line(
        true,
        html`${who} <span class="mono">${repository.fullName}</span> · default branch
          <span class="mono">${repository.defaultBranch}</span> · ${repository.visibility}`,
      );
    }
    case 'failed': {
      const asked = github.hasToken ? 'with the token' : 'without a token';
      return line(false, html`GitHub, asked ${asked}: ${describeFailure(github.failure)}`);
    }
    case 'locked': {
      return skipped(html`GitHub was not asked: unlock editing to let vaultgate use the token.`);
    }
    case 'invalid': {
      return skipped(html`GitHub was not asked: the repository or the token field is not valid.`);
    }
  }
}

function hasAsked(github: GitHubCheck | undefined): boolean {
  return github?.state === 'read' || github?.state === 'failed';
}

export function checkCard(check: PageCheck): Html {
  const { report, at, github } = check;
  const count = report.problems.length + (github?.state === 'failed' ? 1 : 0);
  const status =
    count === 0
      ? pill('ok', 'Everything checks out')
      : pill('bad', `${String(count)} ${count === 1 ? 'problem' : 'problems'}`);
  const credential =
    report.credential === undefined
      ? []
      : [
          itemLine(report.credential.item),
          ...report.credential.fields.map((field) => fieldLine(field)),
        ];
  const note = hasAsked(github)
    ? `Run ${formatInstant(at)}. Nothing was saved; vaultgate asked GitHub about the repository and connected to nothing else.`
    : `Run ${formatInstant(at)}. Nothing was saved and nothing connected.`;
  return html`<section class="card" id="check">
    ${cardHead('Check', note, status)}
    <ul class="checks">
      ${report.endpoints.map((endpoint) => endpointLine(endpoint))} ${credential}
      ${github === undefined ? EMPTY : githubLine(github)}
      ${report.rules.map((rule) => line(false, html`${rule}`))}
    </ul>
  </section>`;
}

/**
A check of a submitted form, with the form's own refusals (the address choice, the deployment) first.
*/
export function withRefusals(report: CheckReport, refused: readonly string[]): CheckReport {
  return {
    ...report,
    problems: [...refused, ...report.problems],
    rules: [...refused, ...report.rules],
  };
}
