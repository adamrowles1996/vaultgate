import {
  clearSessionCookie,
  clearStateCookie,
  field,
  type Form,
  type IdentityContext,
  type IdentityEnvironment,
  readForm,
  readState,
  setSessionCookie,
  setStateCookie,
} from './browser.ts';
import { generateCsrfToken } from './csrf.ts';
import { ipSubject, operatorSubject } from './login-throttle.ts';
import { LOGIN_FAILURE_MESSAGE, renderPasswordStep, renderSecondStep } from './pages/login.ts';
import { hashPassword, isCorrectPassword, requiresRehash } from './password.ts';
import { safeNextPath } from './provider.ts';
import { hashRecoveryCode } from './recovery-codes.ts';
import { verifyTotp } from './totp.ts';

import type { OperatorRecord } from './repositories/operators.ts';
import type { IdentityServices } from './services.ts';
import type { BrowserState } from './state-cookie.ts';
import type { Hono } from 'hono';

const TOTP_SHAPE = /^\d{6}$/;
const FALLBACK_PASSWORD_BYTES = 32;

/**
An anonymous form must carry a valid state cookie and its synchroniser token (ID-12, ID-18).
*/
function requireState(
  context: IdentityContext,
  services: IdentityServices,
  form: Form,
): BrowserState | Response {
  const state = readState(context, services);
  return state === undefined
    ? services.guards.deny(context, 'missing browser state')
    : (services.guards.stateChange(context, form, state.csrfToken) ?? state);
}

/**
 * A hash to verify against when the account does not exist, so an unknown
 * name costs the same scrypt work as a wrong password (ID-12, T9).
 */
function fallbackHashSource(services: IdentityServices): () => Promise<string> {
  const holder: { hash?: Promise<string> } = {};
  return () => {
    holder.hash ??= hashPassword(
      services.random(FALLBACK_PASSWORD_BYTES).toString('base64url'),
      services.random,
      services.passwordParameters,
    );
    return holder.hash;
  };
}

function subjectsFor(services: IdentityServices, context: IdentityContext, operatorId?: string) {
  const ip = services.guards.clientInfo(context).ip;
  return operatorId === undefined ? [ipSubject(ip)] : [ipSubject(ip), operatorSubject(operatorId)];
}

function recordFailure(
  services: IdentityServices,
  context: IdentityContext,
  subjects: readonly string[],
  step: 'password' | 'second-factor',
): void {
  services.throttle.record(subjects, false);
  services.audit.record({
    category: 'identity',
    action: 'login.failed',
    outcome: 'failure',
    ip: services.guards.clientInfo(context).ip,
    requestId: context.get('requestId'),
    details: { step },
  });
}

/**
TOTP for six digits, otherwise a recovery code; returns which one succeeded (ID-10, ID-11).
*/
function verifySecondFactor(
  services: IdentityServices,
  operator: OperatorRecord,
  code: string,
): 'totp' | 'recovery' | undefined {
  const { stores, totpBox, clock } = services;
  const trimmed = code.trim();
  if (TOTP_SHAPE.test(trimmed)) {
    const secret = totpBox.open(operator.totpSecretCiphertext ?? '');
    if (secret === undefined) {
      return undefined;
    }
    const step = verifyTotp({
      secret,
      code: trimmed,
      nowMs: clock(),
      lastStep: operator.totpLastStep,
    });
    if (step === undefined) {
      return undefined;
    }
    stores.operators.updateTotpLastStep(operator.id, step);
    return 'totp';
  }
  const wasConsumed = stores.recoveryCodes.consume(operator.id, hashRecoveryCode(trimmed), clock());
  return wasConsumed ? 'recovery' : undefined;
}

async function passwordStep(
  context: IdentityContext,
  services: IdentityServices,
  fallbackHash: () => Promise<string>,
): Promise<Response> {
  const form = await readForm(context);
  const state = requireState(context, services, form);
  if (state instanceof Response) {
    return state;
  }
  const next = safeNextPath(form.get('next'));
  const password = field(form, 'password');
  const operator = services.stores.operators.findByDisplayName(field(form, 'display_name'));
  const subjects = subjectsFor(services, context, operator?.id);
  await services.delay(services.throttle.delayFor(subjects));
  const storedHash = operator?.passwordHash ?? (await fallbackHash());
  const isCorrect = await isCorrectPassword(password, storedHash);
  if (operator === undefined || !isCorrect) {
    recordFailure(services, context, subjects, 'password');
    const view = { csrfToken: state.csrfToken, next, error: LOGIN_FAILURE_MESSAGE };
    return context.html(renderPasswordStep(view), 401);
  }
  if (requiresRehash(operator.passwordHash, services.passwordParameters)) {
    const upgraded = await hashPassword(password, services.random, services.passwordParameters);
    services.stores.operators.updatePasswordHash(operator.id, upgraded, operator.passwordChangedAt);
  }
  setStateCookie(context, services, {
    csrfToken: state.csrfToken,
    passwordVerifiedOperatorId: operator.id,
  });
  return context.html(renderSecondStep({ csrfToken: state.csrfToken, next, error: undefined }));
}

async function secondStep(context: IdentityContext, services: IdentityServices): Promise<Response> {
  const form = await readForm(context);
  const state = requireState(context, services, form);
  if (state instanceof Response) {
    return state;
  }
  const operator =
    state.passwordVerifiedOperatorId === undefined
      ? undefined
      : services.stores.operators.findById(state.passwordVerifiedOperatorId);
  if (operator === undefined) {
    return services.guards.deny(context, 'password step not completed');
  }
  const next = safeNextPath(form.get('next'));
  const subjects = subjectsFor(services, context, operator.id);
  await services.delay(services.throttle.delayFor(subjects));
  const method = verifySecondFactor(services, operator, field(form, 'code'));
  if (method === undefined) {
    recordFailure(services, context, subjects, 'second-factor');
    const view = { csrfToken: state.csrfToken, next, error: LOGIN_FAILURE_MESSAGE };
    return context.html(renderSecondStep(view), 401);
  }
  services.throttle.record(subjects, true);
  const previous = context.get('session');
  if (previous !== undefined) {
    services.sessions.end(previous.idHash);
  }
  const client = services.guards.clientInfo(context);
  const started = services.sessions.start(operator.id, client);
  setSessionCookie(context, services, started.id);
  clearStateCookie(context, services);
  services.audit.record({
    category: 'identity',
    action: 'login.succeeded',
    outcome: 'ok',
    operatorId: operator.id,
    ip: client.ip,
    requestId: context.get('requestId'),
    details: { method },
  });
  return context.redirect(next, 303);
}

export function registerLoginRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  const fallbackHash = fallbackHashSource(services);

  app.get('/login', (context) => {
    const next = safeNextPath(context.req.query('next'));
    if (context.get('session') !== undefined) {
      return context.redirect(next, 303);
    }
    const csrfToken = generateCsrfToken(services.random);
    setStateCookie(context, services, { csrfToken });
    return context.html(renderPasswordStep({ csrfToken, next, error: undefined }));
  });

  app.post('/login', (context) => passwordStep(context, services, fallbackHash));
  app.post('/login/verify', (context) => secondStep(context, services));

  app.post('/logout', async (context) => {
    const session = context.get('session');
    if (session === undefined) {
      return context.redirect('/login', 303);
    }
    const denied = services.guards.stateChange(context, await readForm(context), session.csrfToken);
    if (denied !== undefined) {
      return denied;
    }
    services.sessions.end(session.idHash);
    clearSessionCookie(context, services);
    services.audit.record({
      category: 'identity',
      action: 'logout',
      outcome: 'ok',
      operatorId: session.operatorId,
      ip: services.guards.clientInfo(context).ip,
      requestId: context.get('requestId'),
    });
    return context.redirect('/login', 303);
  });
}
