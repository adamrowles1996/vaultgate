/**
 * The one-button writes of a target's page (ACT-5, ACT-7, ACT-8, ACT-9):
 * enable, disable, delete, grant, revoke a grant, close sessions. Each is
 * gated like every sensitive account action, then handed to the targets
 * service, which records the event; a refused grant re-renders the page with
 * the reason.
 */
import { targetPath } from './section.ts';
import { renderTargetPage } from './target-page.ts';
import { type ActionsPagesDependencies, targetPageView, viewerOf } from './view.ts';

import type {
  IdentityContext,
  IdentityEnvironment,
  SensitiveActionContext,
} from '../../identity/index.ts';
import type { TargetResult, TargetSummary } from '../targets.ts';
import type { Hono } from 'hono';

const CLIENT_FIELD = 'client_id';

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
  if (outcome.ok) {
    return context.redirect(`${targetPath(ready.target.id)}?notice=${route.notice}`, 303);
  }
  const extras = { error: outcome.error.problems.join('; ') };
  const view = await targetPageView(
    dependencies,
    ready.target,
    viewerOf(ready.gate.session),
    extras,
  );
  return context.html(renderTargetPage(view), 400);
}

/**
ACT-8: the target goes with its grants and sessions; its calls stay. Back to the account page.
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
  return context.redirect('/account#actions', 303);
}

export function registerTargetWrites(
  app: Hono<IdentityEnvironment>,
  dependencies: ActionsPagesDependencies,
): void {
  for (const route of WRITES) {
    app.post(`/account/actions/:id/${route.path}`, (context) =>
      performWrite(context, dependencies, route, context.req.param('id')),
    );
  }
  app.post('/account/actions/:id/delete', (context) =>
    remove(context, dependencies, context.req.param('id')),
  );
}
