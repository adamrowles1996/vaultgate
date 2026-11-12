import { encodeQR } from 'qr';

import { document, EMPTY, errorBanner, hidden, html } from './template.ts';

import type { Enrolment } from '../totp.ts';

export function renderSetupUnavailable(): string {
  return document(
    'Setup',
    html`<h2>Setup</h2>
      <p>Open the setup link printed in the server log to create the operator account.</p>`,
  );
}

export interface SetupFormView {
  readonly token: string;
  readonly csrfToken: string;
  readonly enrolment: Enrolment;
  readonly email: string;
  readonly error: string | undefined;
}

/**
ID-9: encode locally and embed in the protected, no-store page; never send the URI to a service.
*/
export function renderEnrolmentDetails(enrolment: Enrolment): ReturnType<typeof html> {
  return html`${renderEnrolmentQr(enrolment.uri)}
    <p>
      Add vaultgate to your authenticator app by entering this key manually:
      <code>${enrolment.secretBase32}</code>
    </p>
    <p>Or paste the full URI: <code>${enrolment.uri}</code></p>`;
}

/**
An oversized label must not prevent the text fallbacks or validation errors rendering.
*/
function renderEnrolmentQr(uri: string): ReturnType<typeof html> {
  try {
    const source = encodeQR(uri, 'data-url', { border: 4, scale: 4 });
    return html`<p>Scan this QR code with your authenticator app to add vaultgate.</p>
      <img
        class="enrolment-qr"
        src="${source}"
        alt="Scan to add vaultgate to your authenticator"
      />`;
  } catch {
    return EMPTY;
  }
}

export function renderSetupForm(view: SetupFormView): string {
  return document(
    'Create the operator account',
    html`<h2>Create the operator account</h2>
      ${errorBanner(view.error)}
      <form method="post" action="/setup">
        ${hidden('token', view.token)} ${hidden('csrf', view.csrfToken)}
        <label
          >E-mail address
          <input
            name="email"
            type="email"
            required
            maxlength="254"
            autocomplete="username"
            value="${view.email}"
          />
        </label>
        <label
          >Password (12 to 256 characters)
          <input name="password" type="password" required minlength="12" maxlength="256" />
        </label>
        <h3>Authenticator</h3>
        ${renderEnrolmentDetails(view.enrolment)}
        <label
          >Code from your authenticator
          <input name="code" inputmode="numeric" autocomplete="one-time-code" required />
        </label>
        <button type="submit">Create account</button>
      </form>`,
  );
}
