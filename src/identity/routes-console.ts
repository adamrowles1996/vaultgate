/**
 * The console pages identity serves besides Account & security (ID-19):
 * Agents (OAUTH-30), Activity (OPS-5), Vault (ID-25) and Unlock editing
 * (ID-15). Reading them needs a signed-in operator and nothing more; a
 * visitor without a session signs in and comes back, and an account with no
 * e-mail address yet (ID-26) is sent to set one first.
 */
import { renderConsolePage } from './console-chrome.ts';
import { activityPage, agentsPage, unlockPage } from './pages/console-pages.ts';
import { EMPTY_VAULT_FORM, vaultPage, type VaultFormValues } from './pages/vault-connection.ts';
import { loginLocation, safeNextPath } from './provider.ts';

import type { Authenticated } from './account-response.ts';
import type { IdentityContext, IdentityEnvironment } from './browser.ts';
import type { Html } from './pages/template.ts';
import type { ConsoleSectionPage, IdentityServices } from './services.ts';
import type { SessionState } from './session-manager.ts';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
ID-24: each page's notices, matched as own properties only.
*/
const NOTICES: Readonly<Record<'agents' | 'vault', Readonly<Record<string, string>>>> = {
  agents: {
    disconnected: 'Agent disconnected. Its tokens no longer work and its grants are gone.',
  },
  vault: { 'vault-updated': 'Vault connection saved. The backend is using it now.' },
};

function noticeFor(page: 'agents' | 'vault', context: IdentityContext): string | undefined {
  const table = NOTICES[page];
  const name = context.req.query('notice') ?? '';
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
The signed-in operator a console page is for, or the redirect that gets one.
*/
export function consoleViewer(
  context: IdentityContext,
  services: IdentityServices,
): Authenticated | Response {
  const session = context.get('session');
  const operator =
    session === undefined ? undefined : services.stores.operators.findById(session.operatorId);
  if (session === undefined || operator === undefined) {
    return context.redirect(loginLocation(context.req.raw), 303);
  }
  return operator.email === undefined ? context.redirect('/account', 303) : { session, operator };
}

/**
 * The same check for a page another layer serves (ACT-5): the signed-in
 * session, or the redirect to sign in first or, for an account with no
 * e-mail address yet (ID-26), to set one first.
 */
export type ConsoleAccess = (context: IdentityContext) => SessionState | Response;

export function consoleAccess(services: IdentityServices): ConsoleAccess {
  return (context) => {
    const viewer = consoleViewer(context, services);
    return viewer instanceof Response ? viewer : viewer.session;
  };
}

export async function sectionsFor(
  services: IdentityServices,
  page: ConsoleSectionPage,
  session: SessionState,
): Promise<readonly Html[]> {
  const renderers = services.sections[page] ?? [];
  return Promise.all(renderers.map(async (render) => render(session)));
}

export interface VaultPageOptions {
  readonly error?: string | undefined;
  readonly vaultForm?: VaultFormValues | undefined;
}

/**
The Vault page, as shown or as re-shown after a rejected change (ID-25).
*/
export async function vaultResponse(
  context: IdentityContext,
  session: SessionState,
  services: IdentityServices,
  options: VaultPageOptions & { readonly status?: ContentfulStatusCode } = {},
): Promise<Response> {
  const page = vaultPage({
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
    vault: await services.vaultConnection.status(),
    vaultForm: options.vaultForm ?? EMPTY_VAULT_FORM,
    notice: options.error === undefined ? noticeFor('vault', context) : undefined,
    error: options.error,
    now: services.clock(),
    sections: await sectionsFor(services, 'vault', session),
  });
  return context.html(await renderConsolePage(services, session, page), options.status ?? 200);
}

/**
The Activity page, as shown or as re-shown after a rejected export (OPS-5).
*/
export async function activityResponse(
  context: IdentityContext,
  session: SessionState,
  services: IdentityServices,
  error?: string,
): Promise<Response> {
  const page = activityPage({
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
    notice: undefined,
    error,
    sections: await sectionsFor(services, 'activity', session),
  });
  return context.html(
    await renderConsolePage(services, session, page),
    error === undefined ? 200 : 400,
  );
}

async function showAgents(context: IdentityContext, services: IdentityServices) {
  const viewer = consoleViewer(context, services);
  if (viewer instanceof Response) {
    return viewer;
  }
  const { session } = viewer;
  const page = agentsPage({
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
    notice: noticeFor('agents', context),
    error: undefined,
    connectedClients: services.connectedClients(session),
    sections: await sectionsFor(services, 'agents', session),
  });
  return context.html(await renderConsolePage(services, session, page));
}

async function showUnlock(context: IdentityContext, services: IdentityServices) {
  const viewer = consoleViewer(context, services);
  if (viewer instanceof Response) {
    return viewer;
  }
  const { session } = viewer;
  const next = safeNextPath(context.req.query('next'));
  const page = unlockPage({ csrfToken: session.csrfToken, next, error: undefined });
  return context.html(await renderConsolePage(services, session, page));
}

async function show(
  context: IdentityContext,
  services: IdentityServices,
  respond: (session: SessionState) => Promise<Response>,
): Promise<Response> {
  const viewer = consoleViewer(context, services);
  return viewer instanceof Response ? viewer : respond(viewer.session);
}

export function registerConsoleRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.get('/account/agents', (context) => showAgents(context, services));
  app.get('/account/activity', (context) =>
    show(context, services, (session) => activityResponse(context, session, services)),
  );
  app.get('/account/vault', (context) =>
    show(context, services, (session) => vaultResponse(context, session, services)),
  );
  app.get('/account/unlock', (context) => showUnlock(context, services));
}
