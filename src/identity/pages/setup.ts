import { document, errorBanner, hidden, html } from './template.ts';

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
  readonly displayName: string;
  readonly error: string | undefined;
}

/**
The enrolment key is shown as the otpauth URI and as text; no QR image in v1 (see spec 04).
*/
export function renderEnrolmentDetails(enrolment: Enrolment): ReturnType<typeof html> {
  return html`<p>
      Add vaultgate to your authenticator app by entering this key manually:
      <code>${enrolment.secretBase32}</code>
    </p>
    <p>Or paste the full URI: <code>${enrolment.uri}</code></p>`;
}

export function renderSetupForm(view: SetupFormView): string {
  return document(
    'Create the operator account',
    html`<h2>Create the operator account</h2>
      ${errorBanner(view.error)}
      <form method="post" action="/setup">
        ${hidden('token', view.token)} ${hidden('csrf', view.csrfToken)}
        <label
          >Display name
          <input name="display_name" required maxlength="64" value="${view.displayName}" />
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
