/**
 * The one-button writes of a target (ACT-5, ACT-7, ACT-8, ACT-9): enable,
 * disable, delete, grant, revoke a grant, close sessions — from the target's
 * own page, and the two grant writes again from the Agents page (its cards
 * and its matrix), where the target is named in the form instead of the
 * path. Each is gated like every sensitive account action, then handed to
 * the targets service, which records the event; a refused write re-renders
 * the target's page with the reason.
 */
import {
  CLIENT_GRANT_REVOKE_TEMPLATE,
  CLIENT_GRANTS_TEMPLATE,
  CREATE_PATH,
  targetPath,
} from './paths.ts';
import { AGENTS_PATH, RETURN_FIELD, RETURN_TO_AGENTS } from './return-to.ts';
import { targetPage } from './target-page.ts';
import { type ActionsPagesDependencies, targetPageView, viewerOf } from './view.ts';

import type {
  IdentityContext,
  IdentityEnvironment,
  SensitiveActionContext,
} from '../../identity/index.ts';
import type { TargetResult, TargetSummary } from '../targets.ts';
import type { Hono } from 'hono';

const CLIENT_FIELD = 'client_id';

/**
The target a grant written from the connected-clients list names, since the path names the client.
*/
export const TARGET_FIELD = 'target_id';

type Write = (
  dependencies: ActionsPagesDependencies,
  target: TargetSummary,
  gate: SensitiveActionContext,
) => TargetResult;

interface WriteRoute {
  readonly path: string;
  readonly notice: string;
  readonly write: Write;
}

const WRITES: readonly WriteRoute[] = [
  {
    path: 'enable',
    notice: 'enabled',
    write: (dependencies, target, gate) =>
      dependencies.targets.setEnabled(target.id, true, gate.operatorId),
  },
  {
    path: 'disable',
    notice: 'disabled',
    write: (dependencies, target, gate) =>
      dependencies.targets.setEnabled(target.id, false, gate.operatorId),
  },
  {
    path: 'grants',
    notice: 'granted',
    write: (dependencies, target, gate) =>
      dependencies.targets.grant(target.id, gate.form.get(CLIENT_FIELD) ?? '', gate.operatorId),
  },
  {
    path: 'grants/revoke',
    notice: 'grant-revoked',
    write: (dependencies, target, gate) =>
      dependencies.targets.revokeGrant(
        target.id,
        gate.form.get(CLIENT_FIELD) ?? '',
        gate.operatorId,
      ),
  },
  {
    path: 'sessions/close',
    notice: 'sessions-closed',
    write: (dependencies, target, gate) =>
      dependencies.targets.closeSessions(target.id, gate.operatorId),
  },
];

interface Gated {
  readonly gate: SensitiveActionContext;
  readonly target: TargetSummary;
}

/**
The gate, then the target named in the path; a `Response` is the 403 or the 404.
*/
async function gated(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Gated | Response> {
  const gate = await dependencies.sensitiveAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const target = dependencies.targets.get(id);
  return target === undefined ? context.notFound() : { gate, target };
}

/**
What a finished write answers with: the notice it redirects to, or the reason it shows again.
*/
interface Written extends Gated {
  readonly outcome: TargetResult;
  readonly notice: string;
}

/**
The answer to a write: back to the target with its notice, or the page again with the reason.
*/
async function respond(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  written: Written,
): Promise<Response> {
  const { target, gate, outcome, notice } = written;
  if (outcome.ok) {
    return context.redirect(
      gate.form.get(RETURN_FIELD) === RETURN_TO_AGENTS
        ? `${AGENTS_PATH}?notice=${notice}#access`
        : `${targetPath(target.id)}?notice=${notice}`,
      303,
    );
  }
  const extras = { error: outcome.error.problems.join('; ') };
  const view = await targetPageView(dependencies, target, viewerOf(gate.session), extras);
  return context.html(await dependencies.renderConsole(gate.session, targetPage(view)), 400);
}

async function performWrite(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  route: WriteRoute,
  id: string,
): Promise<Response> {
  const ready = await gated(context, dependencies, id);
  if (ready instanceof Response) {
    return ready;
  }
  const outcome = route.write(dependencies, ready.target, ready.gate);
  return respond(context, dependencies, { ...ready, outcome, notice: route.notice });
}

/**
 * ACT-9: the same grant write from the connected-clients list. The client is
 * in the path, the target in the form; the gate, the service and the audit
 * event are the ones the target's own page uses.
 */
async function performClientGrant(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  clientId: string,
  isRevoke: boolean,
): Promise<Response> {
  const gate = await dependencies.sensitiveAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const target = dependencies.targets.get(gate.form.get(TARGET_FIELD) ?? '');
  if (target === undefined) {
    return context.notFound();
  }
  const outcome = isRevoke
    ? dependencies.targets.revokeGrant(target.id, clientId, gate.operatorId)
    : dependencies.targets.grant(target.id, clientId, gate.operatorId);
  const notice = isRevoke ? 'grant-revoked' : 'granted';
  return respond(context, dependencies, { gate, target, outcome, notice });
}

/**
ACT-8: the target goes with its grants and sessions; its calls stay. Back to the Computers page.
*/
async function remove(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const ready = await gated(context, dependencies, id);
  if (ready instanceof Response) {
    return ready;
  }
  dependencies.targets.remove(ready.target.id, ready.gate.operatorId);
  return context.redirect(`${CREATE_PATH}?notice=deleted`, 303);
}

export function registerTargetWrites(
  app: Hono<IdentityEnvironment>,
  dependencies: ActionsPagesDependencies,
): void {
  app.post(CLIENT_GRANTS_TEMPLATE, (context) =>
    performClientGrant(context, dependencies, context.req.param('clientId'), false),
  );
  app.post(CLIENT_GRANT_REVOKE_TEMPLATE, (context) =>
    performClientGrant(context, dependencies, context.req.param('clientId'), true),
  );
  for (const route of WRITES) {
    app.post(`/account/actions/:id/${route.path}`, (context) =>
      performWrite(context, dependencies, route, context.req.param('id')),
    );
  }
  app.post('/account/actions/:id/delete', (context) =>
    remove(context, dependencies, context.req.param('id')),
  );
}
