import { transaction } from '../storage/query.ts';

import { accountResponse, type Authenticated } from './account-response.ts';
import {
  clearStateCookie,
  field,
  type Form,
  type IdentityContext,
  type IdentityEnvironment,
  readForm,
  readState,
  setStateCookie,
} from './browser.ts';
import { renderConsolePage } from './console-chrome.ts';
import { accountSubject, ipSubject } from './login-throttle.ts';
import { renderTotpRotation } from './pages/account.ts';
import { unlockPage } from './pages/console-pages.ts';
import { renderRecoveryCodes } from './pages/recovery-codes.ts';
import { checkPasswordPolicy, hashPassword, isCorrectPassword } from './password.ts';
import { loginLocation, safeNextPath } from './provider.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.ts';
import { describeEnrolment, generateTotpSecret, verifyTotp } from './totp.ts';

import type { IdentityServices } from './services.ts';
import type { SessionState } from './session-manager.ts';
import type { AuditEvent } from '../audit/event.ts';
import type { Hono } from 'hono';

/**
ID-24: matched as an own property, so `?notice=constructor` names no notice rather than answering 500.
*/
const NOTICES: Readonly<Record<string, string>> = {
  reauthenticated: 'Password confirmed. Sensitive actions are available for five minutes.',
  'password-changed': 'Password changed. Every other session has been signed out.',
  'totp-rotated': 'Your authenticator has been replaced.',
  'email-set': 'E-mail address saved. Sign in with it from now on.',
  'email-changed': 'E-mail address changed. Sign in with the new one from now on.',
};

const ACCOUNT_PATH = '/account';

/**
Legacy mode (ID-26): until an e-mail address exists, only setting one (and confirming) is allowed.
*/
const LEGACY_ALLOWED_PATHS = new Set(['/account/reauthenticate', '/account/email']);

/**
A signed-in operator whose form passed the ID-18 checks; otherwise the 403.
*/
function requireAuthenticated(
  context: IdentityContext,
  services: IdentityServices,
  form: Form,
): Authenticated | Response {
  const session = context.get('session');
  if (session === undefined) {
    return services.guards.deny(context, 'no session');
  }
  const denied = services.guards.stateChange(context, form, session.csrfToken);
  if (denied !== undefined) {
    return denied;
  }
  const operator = services.stores.operators.findById(session.operatorId);
  if (operator === undefined) {
    return services.guards.deny(context, 'operator no longer exists');
  }
  return operator.email === undefined && !LEGACY_ALLOWED_PATHS.has(context.req.path)
    ? services.guards.deny(context, 'e-mail address required')
    : { session, operator };
}

/**
ID-15: the sensitive actions additionally need a password check within five minutes.
*/
export function requireReauthenticated(
  context: IdentityContext,
  services: IdentityServices,
  form: Form,
): Authenticated | Response {
  const authenticated = requireAuthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  return authenticated.session.isReauthenticated
    ? authenticated
    : services.guards.deny(context, 're-authentication required');
}

/**
What a sensitive POST served outside this module learns once its gate has passed.
*/
export interface SensitiveActionContext {
  readonly session: SessionState;
  readonly operatorId: string;
  readonly form: Form;
}

/**
 * ID-18 and ID-15 as one gate for a sensitive `POST /account/*` served by
 * another layer (the actions pages, ACT-5): the form is read here so the
 * caller never handles a request body before the checks; a `Response` is the
 * 403 the guards already audited.
 */
export type SensitiveAction = (
  context: IdentityContext,
) => Promise<SensitiveActionContext | Response>;

export function sensitiveAction(services: IdentityServices): SensitiveAction {
  return async (context) => {
    const form = await readForm(context);
    const authenticated = requireReauthenticated(context, services, form);
    return authenticated instanceof Response
      ? authenticated
      : { session: authenticated.session, operatorId: authenticated.operator.id, form };
  };
}

export function auditEvent(
  context: IdentityContext,
  services: IdentityServices,
  action: string,
  operatorId: string,
): AuditEvent {
  return {
    category: 'identity',
    action,
    outcome: 'ok',
    operatorId,
    ip: services.guards.clientInfo(context).ip,
    requestId: context.get('requestId'),
  };
}

const REAUTHENTICATION_REFUSED = 'That password was not recognised.';

/**
A wrong password shows the form it came from again: the account page, or Unlock editing (ID-15).
*/
async function refusedReauthentication(
  context: IdentityContext,
  services: IdentityServices,
  authenticated: Authenticated,
  next: string,
): Promise<Response> {
  if (next === ACCOUNT_PATH || authenticated.operator.email === undefined) {
    const options = { error: REAUTHENTICATION_REFUSED, status: 401 } as const;
    return accountResponse(context, services, authenticated, options);
  }
  const { session } = authenticated;
  const page = unlockPage({ csrfToken: session.csrfToken, next, error: REAUTHENTICATION_REFUSED });
  return context.html(await renderConsolePage(services, session, page), 401);
}

async function reauthenticate(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireAuthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { session, operator } = authenticated;
  const next = safeNextPath(form.get('next'), ACCOUNT_PATH);
  const subjects = [ipSubject(services.guards.clientInfo(context).ip), accountSubject(operator)];
  await services.delay(services.throttle.delayFor(subjects));
  const isCorrect = await isCorrectPassword(field(form, 'password'), operator.passwordHash);
  services.throttle.record(subjects, isCorrect);
  if (!isCorrect) {
    services.audit.record({
      ...auditEvent(context, services, 'reauthentication.failed', operator.id),
      outcome: 'failure',
    });
    return refusedReauthentication(context, services, authenticated, next);
  }
  services.sessions.markReauthenticated(session.idHash);
  services.audit.record(auditEvent(context, services, 'reauthentication.succeeded', operator.id));
  return context.redirect(next === ACCOUNT_PATH ? '/account?notice=reauthenticated' : next, 303);
}

async function changePassword(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { session, operator } = authenticated;
  const password = checkPasswordPolicy(field(form, 'password'));
  if (!password.ok) {
    const options = { error: password.error.message, status: 400 } as const;
    return accountResponse(context, services, authenticated, options);
  }
  const hash = await hashPassword(password.value, services.random, services.passwordParameters);
  services.stores.operators.updatePasswordHash(operator.id, hash, services.clock());
  services.sessions.endOthers(operator.id, session.idHash);
  services.audit.record(auditEvent(context, services, 'password.changed', operator.id));
  return context.redirect('/account?notice=password-changed', 303);
}

async function rotateTotp(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { session, operator } = authenticated;
  const code = form.get('code');
  if (code === undefined) {
    const secret = generateTotpSecret(services.random);
    setStateCookie(context, services, {
      csrfToken: session.csrfToken,
      pendingTotpSecret: secret.toString('base64'),
    });
    const enrolment = describeEnrolment(operator.email, secret);
    return context.html(
      renderTotpRotation({ csrfToken: session.csrfToken, enrolment, error: undefined }),
    );
  }
  const pending = readState(context, services)?.pendingTotpSecret;
  if (pending === undefined) {
    return services.guards.deny(context, 'no pending authenticator');
  }
  const secret = Buffer.from(pending, 'base64');
  const step = verifyTotp({
    secret,
    code: code.trim(),
    nowMs: services.clock(),
    lastStep: undefined,
  });
  if (step === undefined) {
    const enrolment = describeEnrolment(operator.email, secret);
    const view = { csrfToken: session.csrfToken, enrolment, error: 'the code was not accepted' };
    return context.html(renderTotpRotation(view), 400);
  }
  services.stores.operators.updateTotpSecret(operator.id, services.totpBox.seal(secret));
  services.stores.operators.updateTotpLastStep(operator.id, step);
  clearStateCookie(context, services);
  services.audit.record(auditEvent(context, services, 'totp.rotated', operator.id));
  return context.redirect('/account?notice=totp-rotated', 303);
}

async function regenerateRecoveryCodes(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const codes = generateRecoveryCodes(services.random);
  const hashes = codes.map((code) => hashRecoveryCode(code));
  transaction(services.database, () => {
    services.stores.recoveryCodes.replaceAll(authenticated.operator.id, hashes);
  });
  services.audit.record(
    auditEvent(context, services, 'recovery-codes.regenerated', authenticated.operator.id),
  );
  return context.html(renderRecoveryCodes(codes));
}

export function registerAccountRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.get('/account', async (context) => {
    const session = context.get('session');
    const operator =
      session === undefined ? undefined : services.stores.operators.findById(session.operatorId);
    if (session === undefined || operator === undefined) {
      return context.redirect(loginLocation(context.req.raw), 303);
    }
    const name = context.req.query('notice') ?? '';
    const notice = Object.hasOwn(NOTICES, name) ? NOTICES[name] : undefined;
    return accountResponse(context, services, { session, operator }, { notice });
  });
  app.post('/account/reauthenticate', (context) => reauthenticate(context, services));
  app.post('/account/password', (context) => changePassword(context, services));
  app.post('/account/totp/rotate', (context) => rotateTotp(context, services));
  app.post('/account/recovery-codes', (context) => regenerateRecoveryCodes(context, services));
}
