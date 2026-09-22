import { document, hidden, type Html, html, when } from '../identity/pages/template.ts';

import { scopeDefinition, type Scope } from './scopes.ts';

import type { OAuthError } from './errors.ts';
import type { ClientMode } from './repositories/clients.ts';

export interface ConsentView {
  readonly requestId: string;
  readonly csrfToken: string;
  readonly clientName: string;
  readonly redirectHost: string;
  readonly mode: ClientMode;
  readonly loopbackOnly: boolean;
  readonly scopes: readonly Scope[];
}

const MODE_LABELS: Readonly<Record<ClientMode, string>> = {
  preregistered: 'pre-registered by the operator',
  cimd: 'identified by its client metadata document (URL client id)',
  dcr: 'registered dynamically; nobody has vetted this client',
};

/**
 * The scope every client starts from; it cannot be unticked (OAUTH-16).
 */
const FIXED_SCOPES: ReadonlySet<Scope> = new Set(['vault:read']);

export const APPROVE = 'approve';
const DENY = 'deny';

export function scopeFieldName(scope: Scope): string {
  return `scope:${scope}`;
}

function scopeRow(scope: Scope): Html {
  const definition = scopeDefinition(scope);
  const name = scopeFieldName(scope);
  const risk = when(definition.risky, () => html` <strong class="risk">Sensitive</strong>`);
  const control = FIXED_SCOPES.has(scope)
    ? html`<input type="checkbox" checked disabled />${hidden(name, 'on')}`
    : html`<input type="checkbox" name="${name}" value="on" checked />`;
  return html`<li>
    <label>${control} <code>${scope}</code>${risk} — ${definition.explanation}</label>
  </li>`;
}

function loopbackWarning(view: ConsentView): Html {
  return when(
    view.loopbackOnly,
    () =>
      html`<p class="warning">
        <strong>Warning:</strong> this client redirects only to a loopback address
        (<code>${view.redirectHost}</code>). Any program on the computer running your browser could
        be listening there; make sure you started this connection yourself.
      </p>`,
  );
}

/**
 * OAUTH-13, OAUTH-18, OAUTH-36: name, full redirect host, registration
 * mechanism, loopback warning, one line per scope with a risk marker.
 */
export function renderConsentPage(view: ConsentView): string {
  return document(
    'Allow access to your vault?',
    html`<h2>Allow access to your vault?</h2>
      <p>
        <strong>${view.clientName}</strong> is asking to use your Bitwarden vault through vaultgate.
      </p>
      <dl>
        <dt>Client name</dt>
        <dd>${view.clientName}</dd>
        <dt>Will redirect to</dt>
        <dd><code>${view.redirectHost}</code></dd>
        <dt>Registration</dt>
        <dd>${MODE_LABELS[view.mode]}</dd>
      </dl>
      ${loopbackWarning(view)}
      <form method="post" action="/oauth/authorize">
        ${hidden('request_id', view.requestId)} ${hidden('csrf', view.csrfToken)}
        <fieldset>
          <legend>Permissions requested</legend>
          <ul>
            ${view.scopes.map((scope) => scopeRow(scope))}
          </ul>
        </fieldset>
        <button type="submit" name="decision" value="${APPROVE}">Allow</button>
        <button type="submit" name="decision" value="${DENY}">Deny</button>
      </form>`,
  );
}

/**
 * OAUTH-14: a request that cannot be trusted to redirect is answered here.
 */
export function renderErrorPage(error: OAuthError): string {
  return document(
    'Authorization request rejected',
    html`<h2>Authorization request rejected</h2>
      <p>vaultgate could not continue: <code>${error.code}</code>.</p>
      <p>${error.description}</p>
      <p>Nothing has been shared. Return to the application and try again.</p>`,
  );
}
