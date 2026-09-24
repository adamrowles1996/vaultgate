/**
 * What a check found, as the pages show it (ACT-118): each destination host
 * with the address a call would be pinned to or why it is refused, the vault
 * item and each field mapped from it (a secret one sealed), and every other
 * problem. Nothing here is secret: addresses, the item's name and field
 * names. A check saves nothing and connects to nothing.
 */
import { icon } from '../../identity/pages/icons.ts';
import { type Html, html } from '../../identity/pages/template.ts';
import { cardHead, fieldChip, formatInstant, pill, sealed } from '../../identity/pages/ui.ts';

import type { CheckReport, EndpointReport, FieldReport, ItemReport } from '../targets-checks.ts';

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

export function checkCard(report: CheckReport, at: number): Html {
  const count = report.problems.length;
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
  return html`<section class="card" id="check">
    ${cardHead('Check', `Run ${formatInstant(at)}. Nothing was saved and nothing connected.`, status)}
    <ul class="checks">
      ${report.endpoints.map((endpoint) => endpointLine(endpoint))} ${credential}
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
