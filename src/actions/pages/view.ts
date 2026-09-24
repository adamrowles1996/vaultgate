/**
 * What the pages read (ACT-5, ACT-63): the targets with their grants, last
 * call and open sessions for the section; one target with its vault item
 * name, its grants and the clients it could still be granted to, and its
 * last 50 calls for the target page. Reads only; every write goes through
 * the targets service so its ACT-7 event is recorded there.
 */
import { z } from 'zod';

import { countOpenSessions } from '../sessions.ts';
import { validateTarget } from '../targets-schemas.ts';

import { targetCalls } from './calls-view.ts';
import { defaultValues, type FormValues, valuesFromDocuments } from './form-values.ts';
import { formFor } from './forms.ts';
import { type FieldProblems, groupProblems, NO_PROBLEMS } from './messages.ts';
import { summarise } from './summary.ts';
import { DESCRIPTION_FIELD, drawnPaths, INTERNAL_FIELD, ITEM_ID_FIELD } from './target-form.ts';

import type { ConnectorForm, FormSwitches } from './descriptors.ts';
import type { ClientChoice, GrantItem, TargetPageView } from './target-page.ts';
import type {
  ConsoleAccess,
  ConsoleRenderer,
  IdentityContext,
  IdentityEnvironment,
  SensitiveAction,
  SessionState,
} from '../../identity/index.ts';
import type { VaultClient } from '../../vault/client.ts';
import type { TargetsService, TargetSummary } from '../targets.ts';
import type { MiddlewareHandler } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

/**
The clients that currently hold a consent, from the OAuth layer by injection (ACT-9, ACT-70).
*/
export type ClientLister = (operatorId: string) => readonly ClientChoice[];

/**
ID-19: the identity module's page-header middleware, injected (ACT-70).
*/
export type PageHeaders = MiddlewareHandler<IdentityEnvironment>;

export interface ActionsPagesDependencies {
  readonly targets: TargetsService;
  readonly database: DatabaseSync;
  /**
  ACT-4: the item's name is shown once a target is saved; metadata only.
  */
  readonly vault: Pick<VaultClient, 'getItem'>;
  /**
  The identity module's ID-18 and ID-15 gate, injected by the composition layer (ACT-70).
  */
  readonly sensitiveAction: SensitiveAction;
  /**
   * ID-19's CSP and `no-store`, injected the same way. The pages set them
   * themselves rather than inheriting them from whatever identity happens to
   * have registered on `/account/*` before them: a header that arrives only
   * because of mount order is not a header the pages own.
   */
  readonly pageHeaders: PageHeaders;
  readonly listClients: ClientLister;
  /**
  The deployment switches the forms depend on (§13.14, ACT-88).
  */
  readonly switches: FormSwitches;
  /**
  ID-19: the console's frame around every page, injected from identity (ACT-70).
  */
  readonly renderConsole: ConsoleRenderer;
  /**
  Who may read these pages (ID-26), from identity the same way (ACT-70).
  */
  readonly consoleAccess: ConsoleAccess;
  readonly now: () => number;
}

/**
What a page adds to a target's view: a notice, or the error of a refused write.
*/
export interface PageExtras {
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
}

/**
ACT-88: a target whose policy allows any command, whichever connector it belongs to.
*/
const unrestrictedSchema = z.object({ any_command: z.literal(true) });

export function clientNames(clients: readonly ClientChoice[]): ReadonlyMap<string, string> {
  return new Map(clients.map((client) => [client.clientId, client.clientName ?? client.clientId]));
}

export function activeGrants(
  target: TargetSummary,
  names: ReadonlyMap<string, string>,
): GrantItem[] {
  return target.grants
    .filter((grant) => grant.revokedAt === undefined)
    .map((grant) => ({
      clientId: grant.clientId,
      clientName: names.get(grant.clientId) ?? grant.clientId,
      grantedAt: grant.grantedAt,
    }));
}

/**
 * The edit form's values: the documents as the engine reads them (defaults
 * filled in, so the form shows the policy in force) plus the common fields;
 * a row that fails its schema (ACT-1) shows what is stored, for repair.
 */
export function targetValues(form: ConnectorForm, target: TargetSummary): FormValues {
  const validated = validateTarget(target);
  const documents =
    validated.state === 'valid'
      ? validated.documents
      : {
          destination: target.destination,
          credential: target.credential.mapping,
          policy: target.policy,
        };
  const values = new Map(valuesFromDocuments(form, documents));
  values.set(DESCRIPTION_FIELD, target.description);
  values.set(ITEM_ID_FIELD, target.credential.item_id);
  if (target.internal) {
    values.set(INTERNAL_FIELD, 'on');
  }
  return values;
}

export function createValues(form: ConnectorForm): FormValues {
  return defaultValues(form);
}

/**
ACT-6: a rejected save's problems against the controls of the form that would have saved it.
*/
export function fieldProblems(
  form: ConnectorForm,
  problems: readonly string[] | undefined,
): FieldProblems {
  return problems === undefined ? NO_PROBLEMS : groupProblems(problems, drawnPaths(form));
}

/**
 * ACT-49: the target allows an operation that is not a read and asks no
 * human to confirm one. A row that fails its schema (ACT-1) refuses every
 * call, so it needs no such note.
 */
function isUnconfirmed(target: TargetSummary): boolean {
  const validated = validateTarget(target);
  return (
    validated.state === 'valid' &&
    !validated.documents.common.confirm_writes &&
    validated.schemas.allowsNonRead(validated.documents.policy)
  );
}

/**
ACT-4, ACT-54: the item's name, or the precise reason the operator (and only the operator) may see.
*/
export async function describeItem(
  vault: Pick<VaultClient, 'getItem'>,
  itemId: string,
): Promise<string> {
  const item = await vault.getItem(itemId);
  if (item.ok) {
    return item.value.name;
  }
  return item.error.code === 'not_found'
    ? 'no such item in the vault'
    : `the item could not be checked: ${item.error.code}`;
}

export interface Viewer {
  readonly session: SessionState;
  readonly operatorId: string;
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
}

export function viewerOf(session: SessionState): Viewer {
  return {
    session,
    operatorId: session.operatorId,
    csrfToken: session.csrfToken,
    isReauthenticated: session.isReauthenticated,
  };
}

/**
 * The signed-in operator a read-only page of this section needs, or the
 * identity module's redirect: to the login form that returns here
 * afterwards, or to set an e-mail address first (ID-26). The writes go
 * through the identity module's injected gate instead (ID-15, ID-18).
 */
export function signedIn(context: IdentityContext, access: ConsoleAccess): Viewer | Response {
  const session = access(context);
  return session instanceof Response ? session : viewerOf(session);
}

export async function targetPageView(
  dependencies: ActionsPagesDependencies,
  target: TargetSummary,
  viewer: Viewer,
  extras: PageExtras = {},
): Promise<TargetPageView> {
  const clients = dependencies.listClients(viewer.operatorId);
  const names = clientNames(clients);
  const grants = activeGrants(target, names);
  const granted = new Set(grants.map((grant) => grant.clientId));
  return {
    csrfToken: viewer.csrfToken,
    isReauthenticated: viewer.isReauthenticated,
    isUnrestricted: unrestrictedSchema.safeParse(target.policy).success,
    isUnconfirmed: isUnconfirmed(target),
    notice: extras.notice,
    error: extras.error,
    target,
    summary: summarise(target),
    itemName: await describeItem(dependencies.vault, target.credential.item_id),
    openSessions: countOpenSessions(dependencies.database, target.id),
    grants,
    candidates: clients.filter((client) => !granted.has(client.clientId)),
    calls: targetCalls(dependencies.database, target.id, undefined, names).calls,
    isEditable: formFor(target.connector, dependencies.switches) !== undefined,
    now: dependencies.now(),
  };
}
