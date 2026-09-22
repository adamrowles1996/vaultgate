import { document, html } from './template.ts';

/**
Shown exactly once, after setup or regeneration (ID-3, ID-11).
*/
export function renderRecoveryCodes(codes: readonly string[]): string {
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
      <p><a href="/account">Continue to your account</a></p>`,
  );
}
