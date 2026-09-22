import { escapeHtml, htmlDocument } from './html.ts';
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
const UNTICKABLE: readonly Scope[] = ['vault:read'];

export const APPROVE = 'approve';
export const DENY = 'deny';

export function scopeFieldName(scope: Scope): string {
  return `scope:${scope}`;
}

function scopeRow(scope: Scope): string {
  const definition = scopeDefinition(scope);
  const fixed = UNTICKABLE.includes(scope);
  const name = escapeHtml(scopeFieldName(scope));
  const risk = definition.risky ? ' <strong class="risk">Sensitive</strong>' : '';
  const control = fixed
    ? `<input type="checkbox" checked disabled><input type="hidden" name="${name}" value="on">`
    : `<input type="checkbox" name="${name}" value="on" checked>`;
  return `<li><label>${control} <code>${escapeHtml(scope)}</code>${risk} — ${escapeHtml(definition.explanation)}</label></li>`;
}

function loopbackWarning(view: ConsentView): string {
  return view.loopbackOnly
    ? `<p class="warning"><strong>Warning:</strong> this client redirects only to a loopback address (<code>${escapeHtml(view.redirectHost)}</code>). Any program on the computer running your browser could be listening there; make sure you started this connection yourself.</p>`
    : '';
}

/**
 * OAUTH-13, OAUTH-18, OAUTH-36: name, full redirect host, registration
 * mechanism, loopback warning, one line per scope with a risk marker.
 */
export function renderConsentPage(view: ConsentView): string {
  const body = [
    '<h1>Allow access to your vault?</h1>',
    `<p><strong>${escapeHtml(view.clientName)}</strong> is asking to use your Bitwarden vault through vaultgate.</p>`,
    '<dl>',
    `<dt>Client name</dt><dd>${escapeHtml(view.clientName)}</dd>`,
    `<dt>Will redirect to</dt><dd><code>${escapeHtml(view.redirectHost)}</code></dd>`,
    `<dt>Registration</dt><dd>${escapeHtml(MODE_LABELS[view.mode])}</dd>`,
    '</dl>',
    loopbackWarning(view),
    '<form method="post" action="/oauth/authorize">',
    `<input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}">`,
    `<input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}">`,
    '<fieldset><legend>Permissions requested</legend><ul>',
    ...view.scopes.map((scope) => scopeRow(scope)),
    '</ul></fieldset>',
    `<button type="submit" name="decision" value="${APPROVE}">Allow</button>`,
    `<button type="submit" name="decision" value="${DENY}" formnovalidate>Deny</button>`,
    '</form>',
  ].join('\n');
  return htmlDocument('Allow access to your vault?', body);
}

/**
 * OAUTH-14: a request that cannot be trusted to redirect is answered here.
 */
export function renderErrorPage(error: OAuthError): string {
  const body = [
    '<h1>Authorization request rejected</h1>',
    `<p>vaultgate could not continue: <code>${escapeHtml(error.code)}</code>.</p>`,
    `<p>${escapeHtml(error.description)}</p>`,
    '<p>Nothing has been shared. Return to the application and try again.</p>',
  ].join('\n');
  return htmlDocument('Authorization request rejected', body);
}
