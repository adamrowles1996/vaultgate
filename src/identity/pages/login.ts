import { document, errorBanner, hidden, html, when } from './template.ts';

export const LOGIN_FAILURE_MESSAGE = 'Those details were not recognised.';

/**
`legacy` is an account with no e-mail address yet: password only on the first step (ID-26).
*/
export type LoginMode = 'email' | 'legacy';

export interface LoginView {
  readonly csrfToken: string;
  readonly next: string;
  readonly error: string | undefined;
}

export interface PasswordStepView extends LoginView {
  readonly mode: LoginMode;
}

export function renderPasswordStep(view: PasswordStepView): string {
  return document(
    'Sign in',
    html`<h2>Sign in</h2>
      ${errorBanner(view.error)}
      <form method="post" action="/login">
        ${hidden('csrf', view.csrfToken)} ${hidden('next', view.next)}
        ${when(
          view.mode === 'email',
          () =>
            html`<label
              >E-mail address
              <input name="email" type="email" required autocomplete="username" />
            </label>`,
        )}
        <label
          >Password
          <input name="password" type="password" required autocomplete="current-password" />
        </label>
        <button type="submit">Continue</button>
      </form>`,
  );
}

export function renderSecondStep(view: LoginView): string {
  return document(
    'Second step',
    html`<h2>Second step</h2>
      ${errorBanner(view.error)}
      <form method="post" action="/login/verify">
        ${hidden('csrf', view.csrfToken)} ${hidden('next', view.next)}
        <label
          >Authenticator code or a recovery code
          <input name="code" autocomplete="one-time-code" required />
        </label>
        <button type="submit">Sign in</button>
      </form>`,
  );
}
