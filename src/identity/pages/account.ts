import { auditExportSection } from './audit-export.ts';
import { changeEmailSection, renderSetEmail } from './email.ts';
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
  when,
} from './template.ts';
import { vaultConnectionSection, type VaultFormValues } from './vault-connection.ts';

import type { VaultConnectionStatus } from '../../vault/connection.ts';
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
  /**
  Filled by the OAuth layer with the connected clients; empty until then.
  */
  readonly connectedClients: Html;
  /**
  Sections other layers add (the actions targets, ACT-5); rendered after the vault connection.
  */
  readonly extraSections: readonly Html[];
  readonly vault: VaultConnectionStatus;
  /**
  The non-secret vault fields to show again after a failed submission.
  */
  readonly vaultForm: VaultFormValues;
}

const SESSION_COLUMNS = ['Started', 'Last seen', 'Address', 'Browser'] as const;

function sessionRow(session: SessionView): Html {
  const marker = when(session.isCurrent, () => html` <em>(this one)</em>`);
  const started = html`<span>${session.createdAt}${marker}</span>`;
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

function sensitiveActions(view: AccountView, email: string): Html {
  const passwordField = html`<label
    >New password
    <input name="password" type="password" required minlength="12" maxlength="256" />
  </label>`;
  return html`${changeEmailSection(email, view.csrfToken)}
    <section>
      <h3>Change password</h3>
      ${actionForm('/account/password', view.csrfToken, 'Change password', passwordField)}
    </section>
    <section>
      <h3>Authenticator</h3>
      ${actionForm('/account/totp/rotate', view.csrfToken, 'Set up a new authenticator', html``)}
    </section>
    <section>
      <h3>Recovery codes</h3>
      ${actionForm('/account/recovery-codes', view.csrfToken, 'Generate new recovery codes', html``)}
    </section>`;
}

/**
Legacy mode (ID-26) shows the set-your-e-mail page in place of the account page until one is set.
*/
export function renderAccount(view: AccountView): string {
  const { email } = view;
  if (email === undefined) {
    return renderSetEmail(view);
  }
  const rows = view.sessions.map((session) => sessionRow(session));
  const reauthenticateField = html`<label
    >Password
    <input name="password" type="password" required autocomplete="current-password" />
  </label>`;
  return document(
    'Account',
    html`<h2>Account</h2>
      ${errorBanner(view.error)} ${noticeBanner(view.notice)}
      <p>Signed in as <strong>${email}</strong>.</p>
      ${actionForm('/logout', view.csrfToken, 'Sign out', html``)}
      <section>
        <h3>Connected clients</h3>
        ${view.connectedClients}
      </section>
      <section>
        <h3>Sessions</h3>
        <table>
          ${tableHead(SESSION_COLUMNS)}
          <tbody>
            ${rows}
          </tbody>
        </table>
      </section>
      <section id="sensitive-actions">
        <h3>Sensitive actions</h3>
        ${when(
          !view.isReauthenticated,
          () =>
            html`<p>
                Confirm your password to change it or your e-mail address, rotate your authenticator
                or regenerate recovery codes. The confirmation lasts five minutes.
              </p>
              ${actionForm('/account/reauthenticate', view.csrfToken, 'Confirm', reauthenticateField)}`,
        )}
        ${when(view.isReauthenticated, () => sensitiveActions(view, email))}
      </section>
      ${vaultConnectionSection(view)} ${view.extraSections} ${auditExportSection(view)}`,
  );
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
        <button type="submit">Switch authenticator</button>
      </form>
      <p><a href="/account">Cancel</a></p>`,
  );
}
