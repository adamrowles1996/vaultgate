import { bitwardenServerSchema } from '../config/primitives.ts';
import { fail, ok, type Result } from '../result.ts';

import {
  field,
  type Form,
  type IdentityContext,
  type IdentityEnvironment,
  readForm,
} from './browser.ts';
import { VAULT_SYNC_PATH, type VaultFormValues } from './pages/vault-connection.ts';
import { auditEvent, requireAuthenticated, requireReauthenticated } from './routes-account.ts';
import { vaultResponse } from './routes-console.ts';

import type { IdentityServices } from './services.ts';
import type { VaultConnectionInput } from '../vault/connection.ts';
import type { Hono } from 'hono';

const MAX_FIELD_LENGTH = 1024;
const UNAVAILABLE_STATUS = 503;

interface Secrets {
  readonly clientSecret: string | undefined;
  readonly masterPassword: string | undefined;
}

/**
The client secret is trimmed (a pasted trailing space is the classic mistake); a password never is.
*/
function blankAsUndefined(text: string): string | undefined {
  return text.length === 0 ? undefined : text;
}

function lengthOf(text: string | undefined): number {
  return text === undefined ? 0 : text.length;
}

function parseSecrets(form: Form, canKeepSecrets: boolean): Result<Secrets> {
  const clientSecret = blankAsUndefined(field(form, 'client_secret').trim());
  const masterPassword = blankAsUndefined(field(form, 'master_password'));
  const isMissing = clientSecret === undefined || masterPassword === undefined;
  if (isMissing && !canKeepSecrets) {
    return fail(new Error('enter both the API key client secret and the master password'));
  }
  return Math.max(lengthOf(clientSecret), lengthOf(masterPassword)) > MAX_FIELD_LENGTH
    ? fail(new Error('a secret is longer than the vault accepts'))
    : ok({ clientSecret, masterPassword });
}

/**
The account page's own validation (ID-25): the server through the configuration primitive,
a client id, and both secrets unless there is a running connection to keep them from.
*/
function parseVaultForm(form: Form, canKeepSecrets: boolean): Result<VaultConnectionInput> {
  const serverText = field(form, 'server_url').trim();
  const server = bitwardenServerSchema.safeParse(serverText === '' ? undefined : serverText);
  if (!server.success) {
    return fail(new Error('the server must be bitwarden.eu or an https:// URL'));
  }
  const clientId = field(form, 'client_id').trim();
  if (clientId.length === 0 || clientId.length > MAX_FIELD_LENGTH) {
    return fail(new Error('enter the API key client id'));
  }
  const secrets = parseSecrets(form, canKeepSecrets);
  return secrets.ok ? ok({ serverUrl: server.data, clientId, ...secrets.value }) : secrets;
}

function submittedValues(form: Form): VaultFormValues {
  return { serverUrl: field(form, 'server_url').trim(), clientId: field(form, 'client_id').trim() };
}

/**
 * `POST /account/vault` (ID-25): same gate as every sensitive action, then
 * save and switch in one step; success redirects to the status, failure
 * re-renders the form with the reason and without either secret.
 */
async function updateVault(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const status = await services.vaultConnection.status();
  const input = parseVaultForm(form, status.configured);
  const vaultForm = submittedValues(form);
  const { session } = authenticated;
  if (!input.ok) {
    const options = { error: input.error.message, vaultForm, status: 400 } as const;
    return vaultResponse(context, session, services, options);
  }
  const operatorId = authenticated.operator.id;
  const outcome = await services.vaultConnection.configure(input.value, operatorId);
  const server = input.value.serverUrl ?? 'bitwarden.com';
  services.audit.record({
    ...auditEvent(context, services, 'vault.settings_updated', operatorId),
    outcome: outcome.ok ? 'ok' : 'failure',
    details: outcome.ok ? { server } : { server, reason: outcome.error.message },
  });
  if (!outcome.ok) {
    const options = {
      error: outcome.error.message,
      vaultForm,
      status: UNAVAILABLE_STATUS,
    } as const;
    return vaultResponse(context, session, services, options);
  }
  return context.redirect('/account/vault?notice=vault-updated', 303);
}

/**
 * `POST /account/vault/sync` (ID-25, VAULT-19): the ID-18 checks and no
 * password confirmation, since a sync changes no setting and shows nothing
 * new; the outcome comes back to the Vault page as a notice, or as the
 * backend's fixed reason with `503`.
 */
async function syncVault(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireAuthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const outcome = await services.vaultConnection.sync();
  services.audit.record({
    ...auditEvent(context, services, 'vault.sync_requested', authenticated.operator.id),
    outcome: outcome.ok ? 'ok' : 'failure',
    ...(!outcome.ok && { details: { reason: outcome.error.code } }),
  });
  if (!outcome.ok) {
    const options = {
      error: `The vault did not sync: ${outcome.error.message}.`,
      status: UNAVAILABLE_STATUS,
    } as const;
    return vaultResponse(context, authenticated.session, services, options);
  }
  return context.redirect('/account/vault?notice=vault-synced', 303);
}

export function registerVaultRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.post('/account/vault', (context) => updateVault(context, services));
  app.post(VAULT_SYNC_PATH, (context) => syncVault(context, services));
}
