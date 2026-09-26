/**
 * The routes of the Computers pages (ACT-5): the list, a computer's page, and
 * "Add computer" and "Edit" with their writes (`form-routes.ts`); the
 * lifecycle and grant writes are in `target-writes.ts` and the call pages in
 * `call-routes.ts`. Every write goes through the identity module's injected
 * gate (ID-18 and the ID-15 window) and every change through the targets
 * service, so its ACT-7 event is recorded there.
 */
import { Hono } from 'hono';

import { registerCallPages } from './call-routes.ts';
import { computersView } from './computers-view.ts';
import { computersPage } from './computers.ts';
import { savedCheck } from './form-check.ts';
import { formRoutes } from './form-routes.ts';
import { isComputerKind } from './kinds.ts';
import { CREATE_PATH, NEW_PATH } from './paths.ts';
import { registerRebuild } from './rebuild.ts';
import { targetPage } from './target-page.ts';
import { registerTargetWrites } from './target-writes.ts';
import { type ActionsPagesDependencies, signedIn, targetPageView, viewerOf } from './view.ts';

import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';

const NOTICES: Readonly<Record<string, string>> = {
  created: 'Connection created.',
  updated: 'Connection saved; its revision has moved on and open confirmations are void.',
  enabled: 'Connection enabled.',
  disabled: 'Connection disabled; agents no longer see it.',
  granted: 'Grant added.',
  'grant-revoked': 'Grant removed and the agent’s sessions on this connection closed.',
  'sessions-closed': 'Every open session on this connection was closed.',
  deleted: 'Connection deleted. Its calls stay in the audit trail.',
  rebuilding: 'Rebuilding the index; this page shows it when it is done.',
};

/**
 * ID-24: the query parameter names one of the notices above and nothing
 * else. A plain index would return an inherited member for `constructor` or
 * `toString`, which the renderer is not typed for and which crashed the page
 * with a 500 that no audit event explained.
 */
function noticeFor(name: string | undefined): string | undefined {
  return name !== undefined && Object.hasOwn(NOTICES, name) ? NOTICES[name] : undefined;
}

async function showComputers(context: IdentityContext, dependencies: ActionsPagesDependencies) {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const kind = context.req.query('kind');
  const filter = isComputerKind(kind) ? kind : undefined;
  const view = await computersView(dependencies, viewer.operatorId, filter);
  const page = computersPage({ ...view, notice: noticeFor(context.req.query('notice')) });
  return context.html(await dependencies.renderConsole(viewer.session, page));
}

async function showTarget(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const target = dependencies.targets.get(id);
  if (target === undefined) {
    return context.notFound();
  }
  const notice = noticeFor(context.req.query('notice'));
  const view = await targetPageView(dependencies, target, viewer, { notice });
  return context.html(await dependencies.renderConsole(viewer.session, targetPage(view)));
}

/**
 * ACT-118, ACT-120: Check now on a saved target. A `POST` behind the
 * operator's session and synchroniser token (ID-18) but not ID-15's window,
 * so a check outside it still runs; a code target's token is read only
 * inside the window, and no page load ever reads one.
 */
async function checkTarget(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const gate = await dependencies.operatorAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const target = dependencies.targets.get(id);
  if (target === undefined) {
    return context.notFound();
  }
  const viewer = viewerOf(gate.session);
  const check = await savedCheck(dependencies, viewer, target);
  const view = await targetPageView(dependencies, target, viewer, { check });
  return context.html(await dependencies.renderConsole(gate.session, targetPage(view)));
}

export function createActionsRoutes(
  dependencies: ActionsPagesDependencies,
): Hono<IdentityEnvironment> {
  const app = new Hono<IdentityEnvironment>();
  // ID-19 on every page and every write of this sub-application, whatever
  // order the composition layer mounts it in.
  app.use(`${CREATE_PATH}/*`, dependencies.pageHeaders);
  app.use(CREATE_PATH, dependencies.pageHeaders);
  registerCallPages(app, dependencies);
  app.get(CREATE_PATH, (context) => showComputers(context, dependencies));
  app.get(NEW_PATH, (context) => formRoutes.showCreate(context, dependencies));
  app.post(CREATE_PATH, (context) => formRoutes.create(context, dependencies));
  app.get(`${CREATE_PATH}/:id`, (context) =>
    showTarget(context, dependencies, context.req.param('id')),
  );
  app.get(`${CREATE_PATH}/:id/edit`, (context) =>
    formRoutes.showEdit(context, dependencies, context.req.param('id')),
  );
  app.post(`${CREATE_PATH}/:id`, (context) =>
    formRoutes.update(context, dependencies, context.req.param('id')),
  );
  app.post(`${CREATE_PATH}/:id/check`, (context) =>
    checkTarget(context, dependencies, context.req.param('id')),
  );
  registerTargetWrites(app, dependencies);
  registerRebuild(app, dependencies);
  return app;
}
