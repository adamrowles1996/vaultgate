/**
 * The console's Account & security page (ID-15): who is signed in, the
 * browser sessions, and the sensitive actions, each behind a password
 * confirmation that lasts five minutes. The vault connection, the connected
 * agents and the audit export have pages of their own.
 */
import { changeEmailSection } from './email.ts';
import { renderEnrolmentDetails } from './setup.ts';
import {
  cell,
  document,
  errorBanner,
  hidden,
  type Html,
  html,
  noticeBanner,
  tableHead,
} from './template.ts';
import { cardHead, pageHead, pill } from './ui.ts';

import type { ConsolePage } from './console.ts';
import type { Enrolment } from '../totp.ts';

interface SessionView {
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly isCurrent: boolean;
}

export interface AccountView {
  /**
  Lower-cased; `undefined` only for an account that predates e-mail identification (ID-26).
  */
  readonly email: string | undefined;
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly sessions: readonly SessionView[];
  readonly notice: string | undefined;
  readonly error: string | undefined;
}

const SESSION_COLUMNS = ['Started', 'Last seen', 'Address', 'Browser'] as const;

const CONFIRM_NOTE =
  'Changing your password or e-mail address, setting up a new authenticator or new recovery ' +
  'codes, changing the vault connection, exporting the audit log and every change to a ' +
  'computer need your password first. The confirmation lasts five minutes.';

function sessionRow(session: SessionView): Html {
  const started = html`<span class="cell-main"
    ><span>${session.createdAt}</span>${session.isCurrent ? pill('ok', 'This one') : html``}</span
  >`;
  return html`<tr>
    ${cell(SESSION_COLUMNS[0], started)} ${cell(SESSION_COLUMNS[1], session.lastSeenAt)}
    ${cell(SESSION_COLUMNS[2], session.ip)} ${cell(SESSION_COLUMNS[3], session.userAgent)}
  </tr>`;
}

function actionForm(action: string, csrfToken: string, label: string, body: Html): Html {
  return html`<form method="post" action="${action}">
    ${hidden('csrf', csrfToken)} ${body}
    <button type="submit">${label}</button>
  </form>`;
}

/**
ID-15: the password check that opens the sensitive actions, then returns to `next`.
*/
export function reauthenticateForm(csrfToken: string, next: string): Html {
  return html`<form method="post" action="/account/reauthenticate">
    ${hidden('csrf', csrfToken)} ${hidden('next', next)}
    <label
      >Password
      <input name="password" type="password" required autocomplete="current-password" />
    </label>
    <button type="submit" class="primary">Confirm</button>
  </form>`;
}

function sensitiveActions(view: AccountView, email: string): Html {
  const passwordField = html`<label
    >New password
    <input name="password" type="password" required minlength="12" maxlength="256" />
  </label>`;
  return html`<div class="grid-2">
    ${changeEmailSection(email, view.csrfToken)}
    <section class="card">
      ${cardHead('Password', 'At least 12 characters. Every other session is signed out.')}
      ${actionForm('/account/password', view.csrfToken, 'Change password', passwordField)}
    </section>
    <section class="card">
      ${cardHead('Authenticator', 'Replace the app that gives you sign-in codes.')}
      ${actionForm('/account/totp/rotate', view.csrfToken, 'Set up a new authenticator', html``)}
    </section>
    <section class="card">
      ${cardHead('Recovery codes', 'New codes replace every code you have now.')}
      ${actionForm('/account/recovery-codes', view.csrfToken, 'Generate new recovery codes', html``)}
    </section>
  </div>`;
}

function sensitiveSection(view: AccountView, email: string): Html {
  if (view.isReauthenticated) {
    return html`<section id="sensitive-actions" class="stack">
      <h2>Sensitive actions</h2>
      ${sensitiveActions(view, email)}
    </section>`;
  }
  return html`<section id="sensitive-actions" class="card">
    ${cardHead('Sensitive actions', CONFIRM_NOTE)} ${reauthenticateForm(view.csrfToken, '/account')}
  </section>`;
}

/**
The Account & security page of an operator with an e-mail address (legacy mode, ID-26, has its own).
*/
export function accountPage(view: AccountView, email: string): ConsolePage {
  const rows = view.sessions.map((session) => sessionRow(session));
  const body = html`${pageHead('Account & security', html`Signed in as <strong>${email}</strong>.`)}
    ${errorBanner(view.error)} ${noticeBanner(view.notice)} ${sensitiveSection(view, email)}
    <section class="card flush">
      ${cardHead('Sessions', 'Every browser signed in to this account.')}
      <table>
        ${tableHead(SESSION_COLUMNS)}
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>`;
  return {
    title: 'Account & security',
    active: 'account',
    crumbs: [{ label: 'Account & security' }],
    body,
    returnTo: '/account',
  };
}

export interface RotateView {
  readonly csrfToken: string;
  readonly enrolment: Enrolment;
  readonly error: string | undefined;
}

export function renderTotpRotation(view: RotateView): string {
  return document(
    'New authenticator',
    html`<h2>New authenticator</h2>
      ${errorBanner(view.error)} ${renderEnrolmentDetails(view.enrolment)}
      <form method="post" action="/account/totp/rotate">
        ${hidden('csrf', view.csrfToken)}
        <label
          >Code from the new authenticator
          <input name="code" inputmode="numeric" autocomplete="one-time-code" required />
        </label>
        <button type="submit" class="primary">Switch authenticator</button>
      </form>
      <p><a href="/account">Cancel</a></p>`,
  );
}
