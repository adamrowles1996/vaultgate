/**
 * One computer's page (ACT-5, ACT-63): its state with any validation problem
 * (ACT-1) and standing warnings (ACT-49, ACT-88), then cards for where it
 * points, what it signs in with (the vault item's name and the fields it
 * maps, secret ones sealed), what its policy allows, the agents granted it
 * (ACT-9) and its recent calls. Inside the re-authentication window (ID-15)
 * the page offers Edit, the grant forms and the lifecycle buttons; outside
 * it, the way to confirm the password and come back here. Every form posts
 * to `/account/actions/...` (ID-18).
 */
import { unlockPath } from '../../identity/pages/console.ts';
import { icon } from '../../identity/pages/icons.ts';
import {
  EMPTY,
  errorBanner,
  hidden,
  type Html,
  html,
  noticeBanner,
  when,
} from '../../identity/pages/template.ts';
import { cardHead, fieldChip, pill, relativeTime, sealed, tag } from '../../identity/pages/ui.ts';

import { renderCallTable } from './calls.ts';
import { checkCard, type PageCheck } from './check-report.ts';
import { indexCard, type IndexView } from './index-card.ts';
import { KINDS } from './kinds.ts';
import { callsPath, checkPath, CREATE_PATH, editPath, targetPath } from './paths.ts';
import { grantsCard, manageCard } from './target-grants.ts';

import type { CallItem } from './calls.ts';
import type { ComputerSummary } from './summary.ts';
import type { ClientChoice, GrantItem } from './target-grants.ts';
import type { ConsolePage } from '../../identity/index.ts';
import type { TargetSummary } from '../targets.ts';

export interface TargetPageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  /**
  ACT-88: the target's policy allows any command; the page says so on every visit.
  */
  readonly isUnrestricted: boolean;
  /**
  ACT-49: the policy allows a non-read operation and asks no human to confirm one.
  */
  readonly isUnconfirmed: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly target: TargetSummary;
  readonly summary: ComputerSummary;
  /**
  The vault item's name (ACT-4), or why it could not be read.
  */
  readonly itemName: string;
  readonly openSessions: number;
  readonly grants: readonly GrantItem[];
  readonly candidates: readonly ClientChoice[];
  readonly calls: readonly CallItem[];
  /**
  False when this build cannot edit the connector's documents (a later milestone's connector).
  */
  readonly isEditable: boolean;
  readonly now: number;
  /**
  What "Check now" found (ACT-118, ACT-120), when the page was asked for it.
  */
  readonly check: PageCheck | undefined;
  /**
  ACT-115: a code target's index, or `undefined` for every other connector.
  */
  readonly index: IndexView | undefined;
}

/**
ACT-88: the standing warning an any-command target carries, shown whether or not it is being edited.
*/
const UNRESTRICTED_WARNING =
  'This connection allows any command: a granted client can run anything its login can, and ' +
  'every call is audited with the full command.';

/**
ACT-49: the note a target carries once the operator turns the confirmation off.
*/
const UNCONFIRMED_NOTE =
  'Confirmation is off: a granted client can change things here without asking anyone. New ' +
  'connections ask for a confirmation on every non-read call; this one relies on the grant and ' +
  'on the prompt the client may show. Review the unexpected writes below.';

function actionForm(action: string, view: TargetPageView, button: Html, body: Html = EMPTY): Html {
  return html`<form method="post" action="${action}">
    ${hidden('csrf', view.csrfToken)} ${body} ${button}
  </form>`;
}

function stateTags(view: TargetPageView): Html {
  const { summary } = view;
  const state =
    summary.state === 'invalid'
      ? pill('bad', 'Needs fixing')
      : pill(
          summary.state === 'enabled' ? 'ok' : 'off',
          summary.state === 'enabled' ? 'Enabled' : 'Disabled',
        );
  const confirmation = {
    confirmed: tag('A person confirms every write', 'green', 'shield'),
    unconfirmed: tag('Writes are not confirmed', 'amber', 'alert'),
    reads: tag('Reads only'),
  }[summary.confirmation];
  return html`${state} ${confirmation}`;
}

function headerActions(view: TargetPageView): Html {
  const base = targetPath(view.target.id);
  const check = actionForm(
    checkPath(view.target.id),
    view,
    html`<button type="submit">${icon('check')}Check now</button>`,
  );
  if (!view.isReauthenticated) {
    return html`${check}
      <a class="button" href="${unlockPath(base)}">${icon('lock')}Unlock editing</a>`;
  }
  const toggle = view.target.enabled
    ? actionForm(
        `${base}/disable`,
        view,
        html`<button type="submit">${icon('pause')}Disable</button>`,
      )
    : actionForm(
        `${base}/enable`,
        view,
        html`<button type="submit">${icon('play')}Enable</button>`,
      );
  return html`${check} ${toggle}
  ${when(
    view.isEditable,
    () =>
      html`<a class="button primary" href="${editPath(view.target.id)}">${icon('pencil')}Edit</a>`,
  )}`;
}

function header(view: TargetPageView): Html {
  const kind = KINDS[view.summary.kind];
  return html`<header class="page-head">
    <div class="cell-with-tile">
      <span class="kind-tile large kind-${view.summary.kind}" title="${kind.label}"
        >${icon(kind.icon)}</span
      >
      <div class="cell-main">
        <div class="toolbar">
          <h1 class="mono">${view.target.name}</h1>
          ${stateTags(view)}
        </div>
        <p class="intro">${view.target.description}</p>
      </div>
    </div>
    <div class="page-actions">${headerActions(view)}</div>
  </header>`;
}

function banners(view: TargetPageView): Html {
  const invalid = when(view.target.state === 'invalid', () =>
    errorBanner(`target_invalid: ${view.target.problems.join('; ')}`),
  );
  const check = view.check === undefined ? EMPTY : checkCard(view.check);
  return html`${check} ${errorBanner(view.error)} ${invalid}
  ${when(view.isUnrestricted, () => errorBanner(UNRESTRICTED_WARNING))}
  ${when(view.isUnconfirmed, () => errorBanner(UNCONFIRMED_NOTE))} ${noticeBanner(view.notice)}`;
}

function connectionCard(view: TargetPageView): Html {
  const { target, summary } = view;
  return html`<section class="card">
    ${cardHead('Connection', undefined, tag(KINDS[summary.kind].label))}
    <dl class="kv">
      <dt>Destination</dt>
      <dd class="mono">${summary.address}</dd>
      <dt>Network</dt>
      <dd>${summary.addressDetail}</dd>
      <dt>Revision</dt>
      <dd>${target.revision} · updated ${relativeTime(target.updatedAt, view.now)}</dd>
      <dt>Open sessions</dt>
      <dd>${view.openSessions}</dd>
    </dl>
  </section>`;
}

function credentialCard(view: TargetPageView): Html {
  const fields = view.summary.fields.map(
    (field) =>
      html`<dt>${field.isSecret ? 'Secret' : 'Username'}</dt>
        <dd>${field.isSecret ? sealed(field.selector) : fieldChip(field.selector)}</dd>`,
  );
  return html`<section class="card">
    ${cardHead(
      'Signs in with',
      'The vault item and the fields vaultgate reads at the moment of each call. Values never appear here.',
    )}
    <dl class="kv">
      <dt>Vault item</dt>
      <dd>
        ${icon('vault')} ${view.itemName}
        <span class="mono cell-sub">${view.target.credential.item_id}</span>
      </dd>
      ${fields}
      ${
        view.summary.credentialNote === undefined
          ? EMPTY
          : html`<dt>Token</dt>
              <dd>${view.summary.credentialNote}</dd>`
      }
    </dl>
  </section>`;
}

function rulesCard(view: TargetPageView): Html {
  const { summary } = view;
  const confirm = {
    confirmed: 'A person confirms every write',
    unconfirmed: 'Writes run without asking anyone',
    reads: 'Nothing to confirm: the policy allows reads only',
  }[summary.confirmation];
  return html`<section class="card">
    ${cardHead('Rules')}
    <dl class="kv">
      <dt>Allows</dt>
      <dd>${summary.allows === '' ? 'see the policy' : summary.allows}</dd>
      <dt>Confirmation</dt>
      <dd>${confirm}</dd>
    </dl>
  </section>`;
}

function callsCard(view: TargetPageView): Html {
  return html`<section class="card flush">
    ${cardHead(
      'Recent calls',
      'Arguments are kept, scrubbed of every injected value; results are never stored.',
      html`<a class="button small" href="${callsPath(view.target.id)}">Whole call history</a>`,
    )}
    ${renderCallTable(view.calls)}
  </section>`;
}

export function targetPage(view: TargetPageView): ConsolePage {
  const { target } = view;
  const context = {
    targetId: target.id,
    csrfToken: view.csrfToken,
    isReauthenticated: view.isReauthenticated,
  };
  return {
    title: target.name,
    active: 'computers',
    crumbs: [
      { label: 'Connections', href: CREATE_PATH },
      { label: KINDS[view.summary.kind].plural, href: `${CREATE_PATH}?kind=${view.summary.kind}` },
      { label: html`<span class="mono">${target.name}</span>` },
    ],
    body: html`${header(view)} ${banners(view)}
      <div class="grid-2">
        ${connectionCard(view)} ${credentialCard(view)} ${rulesCard(view)}
        ${grantsCard({ ...context, grants: view.grants, candidates: view.candidates })}
      </div>
      ${view.index === undefined ? EMPTY : indexCard({ ...context, now: view.now, index: view.index })}
      ${callsCard(view)} ${manageCard({ ...context, isEnabled: target.enabled })}`,
    returnTo: targetPath(target.id),
  };
}

export type { ClientChoice, GrantItem } from './target-grants.ts';
