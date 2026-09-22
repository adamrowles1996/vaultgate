import { transaction } from '../storage/query.ts';

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
import { ipSubject, operatorSubject } from './login-throttle.ts';
import { type AccountView, renderAccount, renderTotpRotation } from './pages/account.ts';
import { renderRecoveryCodes } from './pages/recovery-codes.ts';
import { checkPasswordPolicy, hashPassword, isCorrectPassword } from './password.ts';
import { loginLocation } from './provider.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.ts';
import { describeEnrolment, generateTotpSecret, verifyTotp } from './totp.ts';

import type { AuditEvent } from '../audit/event.ts';
import type { OperatorRecord } from './repositories/operators.ts';
import type { IdentityServices } from './services.ts';
import type { SessionState } from './session-manager.ts';
import type { Hono } from 'hono';

const NOTICES: Readonly<Record<string, string>> = {
  reauthenticated: 'Password confirmed. Sensitive actions are available for five minutes.',
  'password-changed': 'Password changed. Every other session has been signed out.',
  'totp-rotated': 'Your authenticator has been replaced.',
};

export interface Authenticated {
  readonly session: SessionState;
  readonly operator: OperatorRecord;
}

export function accountView(
  services: IdentityServices,
  authenticated: Authenticated,
  notice: string | undefined,
  error: string | undefined,
): AccountView {
  const { session, operator } = authenticated;
  const sessions = services.sessions.list(operator.id).map((record) => ({
    createdAt: new Date(record.createdAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    ip: record.ip ?? 'unknown',
    userAgent: record.userAgent ?? 'unknown',
    isCurrent: record.idHash === session.idHash,
  }));
  return {
    displayName: operator.displayName,
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
    sessions,
    notice,
    error,
    connectedClients: services.connectedClients(session),
  };
}

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
  return operator === undefined
    ? services.guards.deny(context, 'operator no longer exists')
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

async function reauthenticate(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireAuthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { session, operator } = authenticated;
  const subjects = [
    ipSubject(services.guards.clientInfo(context).ip),
    operatorSubject(operator.id),
  ];
  await services.delay(services.throttle.delayFor(subjects));
  const isCorrect = await isCorrectPassword(field(form, 'password'), operator.passwordHash);
  services.throttle.record(subjects, isCorrect);
  if (!isCorrect) {
    services.audit.record({
      ...auditEvent(context, services, 'reauthentication.failed', operator.id),
      outcome: 'failure',
    });
    const view = accountView(
      services,
      authenticated,
      undefined,
      'That password was not recognised.',
    );
    return context.html(renderAccount(view), 401);
  }
  services.sessions.markReauthenticated(session.idHash);
  services.audit.record(auditEvent(context, services, 'reauthentication.succeeded', operator.id));
  return context.redirect('/account?notice=reauthenticated', 303);
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
    const view = accountView(services, authenticated, undefined, password.error.message);
    return context.html(renderAccount(view), 400);
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
    const enrolment = describeEnrolment(operator.displayName, secret);
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
    const enrolment = describeEnrolment(operator.displayName, secret);
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
  app.get('/account', (context) => {
    const session = context.get('session');
    const operator =
      session === undefined ? undefined : services.stores.operators.findById(session.operatorId);
    if (session === undefined || operator === undefined) {
      return context.redirect(loginLocation(context.req.raw), 303);
    }
    const notice = NOTICES[context.req.query('notice') ?? ''];
    return context.html(
      renderAccount(accountView(services, { session, operator }, notice, undefined)),
    );
  });
  app.post('/account/reauthenticate', (context) => reauthenticate(context, services));
  app.post('/account/password', (context) => changePassword(context, services));
  app.post('/account/totp/rotate', (context) => rotateTotp(context, services));
  app.post('/account/recovery-codes', (context) => regenerateRecoveryCodes(context, services));
}
