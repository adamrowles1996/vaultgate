/**
 * The Account & security page as a response (ID-15), shared by every route
 * that shows it again: after a refused password, a rejected new password or
 * e-mail address, and on `GET /account` itself.
 */
import { renderConsolePage } from './console-chrome.ts';
import { accountPage, type AccountView } from './pages/account.ts';
import { renderSetEmail } from './pages/email.ts';
import { formatInstant } from './pages/ui.ts';

import type { IdentityContext } from './browser.ts';
import type { OperatorRecord } from './repositories/operators.ts';
import type { IdentityServices } from './services.ts';
import type { SessionState } from './session-manager.ts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface Authenticated {
  readonly session: SessionState;
  readonly operator: OperatorRecord;
}

export interface AccountViewOptions {
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
}

export function accountView(
  services: IdentityServices,
  authenticated: Authenticated,
  options: AccountViewOptions = {},
): AccountView {
  const { session, operator } = authenticated;
  const sessions = services.sessions.list(operator.id).map((record) => ({
    createdAt: formatInstant(record.createdAt),
    lastSeenAt: formatInstant(record.lastSeenAt),
    ip: record.ip ?? 'unknown',
    userAgent: record.userAgent ?? 'unknown',
    isCurrent: record.idHash === session.idHash,
  }));
  return {
    email: operator.email,
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
    sessions,
    notice: options.notice,
    error: options.error,
  };
}

/**
 * The Account & security page with `options`, answering `status`; in legacy
 * mode (ID-26) the set-your-e-mail page takes its place until an address exists.
 */
export async function accountResponse(
  context: IdentityContext,
  services: IdentityServices,
  authenticated: Authenticated,
  options: AccountViewOptions & { readonly status?: ContentfulStatusCode } = {},
): Promise<Response> {
  const view = accountView(services, authenticated, options);
  const { email } = authenticated.operator;
  const markup =
    email === undefined
      ? renderSetEmail(view)
      : await renderConsolePage(services, authenticated.session, accountPage(view, email));
  return context.html(markup, options.status ?? 200);
}
