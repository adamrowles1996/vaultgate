import { field, type IdentityContext, type IdentityEnvironment, readForm } from './browser.ts';
import { normaliseEmail } from './email.ts';
import { renderAccount } from './pages/account.ts';
import { accountView, auditEvent, requireReauthenticated } from './routes-account.ts';

import type { IdentityServices } from './services.ts';
import type { Hono } from 'hono';

/**
 * `POST /account/email`: sets or changes the address the operator signs in
 * with (ID-3). Same gate as every other sensitive action (ID-15). In legacy
 * mode (ID-26) this is the one action the account page offers until an
 * address exists; the notice differs so the operator knows which happened.
 */
async function changeEmail(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { operator } = authenticated;
  const email = normaliseEmail(field(form, 'email'));
  if (!email.ok) {
    const view = await accountView(services, authenticated, { error: email.error.message });
    return context.html(renderAccount(view), 400);
  }
  services.stores.operators.updateEmail(operator.id, email.value);
  services.audit.record({
    ...auditEvent(context, services, 'email.changed', operator.id),
    details: { email: email.value },
  });
  const notice = operator.email === undefined ? 'email-set' : 'email-changed';
  return context.redirect(`/account?notice=${notice}`, 303);
}

export function registerEmailRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.post('/account/email', (context) => changeEmail(context, services));
}
