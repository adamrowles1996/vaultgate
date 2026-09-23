import { document, html, when } from './template.ts';

export interface RecoveryCodesOptions {
  /**
  Ends the page with the way to the vault connection form (ID-25) when none exists yet.
  */
  readonly connectVault?: boolean;
}

/**
Shown exactly once, after setup or regeneration (ID-3, ID-11).
*/
export function renderRecoveryCodes(
  codes: readonly string[],
  options: RecoveryCodesOptions = {},
): string {
  const items = codes.map((code) => html`<li><code>${code}</code></li>`);
  return document(
    'Recovery codes',
    html`<h2>Your recovery codes</h2>
      <p>
        Store these somewhere safe. Each code signs you in once if you lose your authenticator. They
        are shown only now.
      </p>
      <ul class="codes">
        ${items}
      </ul>
      ${when(
        options.connectVault === true,
        () =>
          html`<p>
            The vault is not connected yet. <a href="/account#vault">Connect the vault</a> from your
            account page with your Bitwarden API key and master password.
          </p>`,
      )}
      <p><a href="/account">Continue to your account</a></p>`,
  );
}
