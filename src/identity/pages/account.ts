import { auditExportSection } from './audit-export.ts';
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

import type { Enrolment } from '../totp.ts';

interface SessionView {
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly isCurrent: boolean;
}

export interface AccountView {
  readonly displayName: string;
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly sessions: readonly SessionView[];
  readonly notice: string | undefined;
  readonly error: string | undefined;
  /**
  Filled by the OAuth layer with the connected clients; empty until then.
  */
  readonly connectedClients: Html;
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

function sensitiveActions(view: AccountView): Html {
  const passwordField = html`<label
    >New password
    <input name="password" type="password" required minlength="12" maxlength="256" />
  </label>`;
  return html`<section>
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

export function renderAccount(view: AccountView): string {
  const rows = view.sessions.map((session) => sessionRow(session));
  const reauthenticateField = html`<label
    >Password
    <input name="password" type="password" required autocomplete="current-password" />
  </label>`;
  return document(
    'Account',
    html`<h2>Account</h2>
      ${errorBanner(view.error)} ${noticeBanner(view.notice)}
      <p>Signed in as <strong>${view.displayName}</strong>.</p>
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
                Confirm your password to change it, rotate your authenticator or regenerate recovery
                codes. The confirmation lasts five minutes.
              </p>
              ${actionForm('/account/reauthenticate', view.csrfToken, 'Confirm', reauthenticateField)}`,
        )}
        ${when(view.isReauthenticated, () => sensitiveActions(view))}
      </section>
      ${auditExportSection(view)}`,
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
