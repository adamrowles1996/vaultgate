import { fail, ok, type Result } from '../result.ts';
import { transaction } from '../storage/query.ts';

import {
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
import { normaliseEmail } from './email.ts';
import { renderRecoveryCodes } from './pages/recovery-codes.ts';
import { renderSetupForm, renderSetupUnavailable } from './pages/setup.ts';
import { checkPasswordPolicy, hashPassword } from './password.ts';
import { randomUuid } from './primitives.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.ts';
import { describeEnrolment, generateTotpSecret, verifyTotp } from './totp.ts';

import type { IdentityServices } from './services.ts';
import type { Hono } from 'hono';

interface SetupInput {
  readonly email: string;
  readonly password: string;
  readonly totpStep: number;
}

interface SetupContext {
  readonly secret: Buffer;
  readonly csrfToken: string;
}

function validate(form: Form, secret: Buffer, now: number): Result<SetupInput> {
  const email = normaliseEmail(field(form, 'email'));
  if (!email.ok) {
    return email;
  }
  const password = checkPasswordPolicy(field(form, 'password'));
  if (!password.ok) {
    return password;
  }
  const code = field(form, 'code');
  const totpStep = verifyTotp({ secret, code, nowMs: now, lastStep: undefined });
  return totpStep === undefined
    ? fail(new Error('the authenticator code was not accepted'))
    : ok({ email: email.value, password: password.value, totpStep });
}

function setupContext(
  context: IdentityContext,
  services: IdentityServices,
  form: Form,
): SetupContext | Response {
  const state = readState(context, services);
  if (state === undefined) {
    return services.guards.deny(context, 'missing browser state');
  }
  const denied = services.guards.stateChange(context, form, state.csrfToken);
  if (denied !== undefined) {
    return denied;
  }
  return state.setupSecret === undefined
    ? services.guards.deny(context, 'missing enrolment state')
    : { secret: Buffer.from(state.setupSecret, 'base64'), csrfToken: state.csrfToken };
}

/**
Consumes the token and creates the operator atomically; false when the token was already spent.
*/
function createOperator(
  services: IdentityServices,
  token: string,
  input: SetupInput,
  material: { passwordHash: string; totpCiphertext: string; recoveryCodes: readonly string[] },
): string | undefined {
  const { database, stores, bootstrap, random, clock } = services;
  return transaction(database, () => {
    if (!bootstrap.consumeToken(token)) {
      return;
    }
    const id = randomUuid(random);
    const now = clock();
    stores.operators.create({
      id,
      email: input.email,
      passwordHash: material.passwordHash,
      totpSecretCiphertext: material.totpCiphertext,
      totpLastStep: input.totpStep,
      createdAt: now,
      passwordChangedAt: now,
    });
    stores.recoveryCodes.replaceAll(
      id,
      material.recoveryCodes.map((code) => hashRecoveryCode(code)),
    );
    return id;
  });
}

interface Completion {
  readonly setup: SetupContext;
  readonly input: SetupInput;
  readonly token: string;
}

async function completeSetup(
  context: IdentityContext,
  services: IdentityServices,
  { setup, input, token }: Completion,
): Promise<Response> {
  const { random, passwordParameters, totpBox, guards, sessions, audit } = services;
  const passwordHash = await hashPassword(input.password, random, passwordParameters);
  const recoveryCodes = generateRecoveryCodes(random);
  const operatorId = createOperator(services, token, input, {
    passwordHash,
    totpCiphertext: totpBox.seal(setup.secret),
    recoveryCodes,
  });
  if (operatorId === undefined) {
    return context.html(renderSetupUnavailable(), 400);
  }
  const client = guards.clientInfo(context);
  const started = sessions.start(operatorId, client);
  setSessionCookie(context, services, started.id);
  clearStateCookie(context, services);
  audit.record({
    category: 'identity',
    action: 'operator.created',
    outcome: 'ok',
    operatorId,
    ip: client.ip,
    requestId: context.get('requestId'),
    details: { email: input.email },
  });
  const vault = await services.vaultConnection.status();
  return context.html(renderRecoveryCodes(recoveryCodes, { connectVault: !vault.configured }));
}

export function registerSetupRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  const { bootstrap, random } = services;

  app.get('/setup', (context) => {
    if (bootstrap.hasOperator()) {
      return context.notFound();
    }
    const token = context.req.query('token');
    if (token === undefined || !bootstrap.isTokenUsable(token)) {
      return context.html(renderSetupUnavailable());
    }
    const secret = generateTotpSecret(random);
    const csrfToken = generateCsrfToken(random);
    setStateCookie(context, services, { csrfToken, setupSecret: secret.toString('base64') });
    const enrolment = describeEnrolment(undefined, secret);
    return context.html(
      renderSetupForm({ token, csrfToken, enrolment, email: '', error: undefined }),
    );
  });

  app.post('/setup', async (context) => {
    if (bootstrap.hasOperator()) {
      return context.notFound();
    }
    const form = await readForm(context);
    const setup = setupContext(context, services, form);
    if (setup instanceof Response) {
      return setup;
    }
    const token = field(form, 'token');
    const input = validate(form, setup.secret, services.clock());
    if (!input.ok) {
      const email = field(form, 'email').trim();
      const enrolment = describeEnrolment(email === '' ? undefined : email, setup.secret);
      const view = { token, csrfToken: setup.csrfToken, enrolment, email };
      return context.html(renderSetupForm({ ...view, error: input.error.message }), 400);
    }
    return completeSetup(context, services, { setup, input: input.value, token });
  });
}
