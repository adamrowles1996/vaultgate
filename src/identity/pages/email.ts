import { document, errorBanner, hidden, type Html, html, noticeBanner, when } from './template.ts';
import { cardHead } from './ui.ts';

/**
What the e-mail pages need from the account view; `email` is `undefined` in legacy mode (ID-26).
*/
export interface EmailView {
  readonly email: string | undefined;
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
}

function emailForm(csrfToken: string, label: string): Html {
  return html`<form method="post" action="/account/email">
    ${hidden('csrf', csrfToken)}
    <label
      >E-mail address
      <input name="email" type="email" required maxlength="254" autocomplete="username" />
    </label>
    <button type="submit">${label}</button>
  </form>`;
}

/**
The "Change e-mail address" section of the sensitive actions (ID-15); shown once re-authenticated.
*/
export function changeEmailSection(email: string, csrfToken: string): Html {
  return html`<section class="card">
    ${cardHead('E-mail address', html`You sign in with this address; it is <strong>${email}</strong> now.`)}
    ${emailForm(csrfToken, 'Change e-mail address')}
  </section>`;
}

/**
 * Legacy mode (ID-26): an account created before the `operator-email`
 * migration has no e-mail address, so the account page is replaced by this
 * one until an address is set. Setting it is a sensitive action and needs the password confirmed
 * first (ID-15); signing out is the only other thing offered.
 */
export function renderSetEmail(view: EmailView): string {
  const confirm = html`<form method="post" action="/account/reauthenticate">
    ${hidden('csrf', view.csrfToken)}
    <label
      >Password
      <input name="password" type="password" required autocomplete="current-password" />
    </label>
    <button type="submit">Confirm</button>
  </form>`;
  const signOut = html`<form method="post" action="/logout">
    ${hidden('csrf', view.csrfToken)}
    <button type="submit">Sign out</button>
  </form>`;
  return document(
    'Set your e-mail address',
    html`<h2>Set your e-mail address</h2>
      ${errorBanner(view.error)} ${noticeBanner(view.notice)}
      <p>
        This account was created before operator accounts were identified by e-mail address. Set
        yours to continue; from then on you sign in with it instead of a name.
      </p>
      ${when(
        !view.isReauthenticated,
        () =>
          html`<p>Confirm your password first.</p>
            ${confirm}`,
      )}
      ${when(view.isReauthenticated, () => emailForm(view.csrfToken, 'Set e-mail address'))}
      ${signOut}`,
  );
}
