/**
 * The two read-only call pages of ACT-63: one target's whole history, 50 at
 * a time with an "older calls" link, and the unexpected-write view across
 * every target. Both need a signed-in operator and nothing more — they
 * change nothing, so the ID-15 window does not apply — and both read through
 * `calls-view.ts`, never SQL.
 */
import { targetCalls, unexpectedCalls } from './calls-view.ts';
import { callHistoryPage, type CallCursor, parseCursor, unexpectedPage } from './calls.ts';
import { CREATE_PATH, UNEXPECTED_PATH } from './paths.ts';
import { type ActionsPagesDependencies, clientNames, signedIn } from './view.ts';

import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';
import type { Hono } from 'hono';

const CURSOR_PARAMETER = 'before';

function cursorOf(context: IdentityContext): CallCursor | undefined {
  return parseCursor(context.req.query(CURSOR_PARAMETER));
}

async function showUnexpected(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
): Promise<Response> {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const live = new Set(dependencies.targets.list().map((target) => target.id));
  const names = clientNames(dependencies.listClients(viewer.operatorId));
  const page = unexpectedCalls(dependencies.database, live, cursorOf(context), names);
  return context.html(await dependencies.renderConsole(viewer.session, unexpectedPage(page)));
}

async function showHistory(
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
  const names = clientNames(dependencies.listClients(viewer.operatorId));
  const calls = targetCalls(dependencies.database, target.id, cursorOf(context), names);
  const page = callHistoryPage({ targetId: target.id, targetName: target.name, ...calls });
  return context.html(await dependencies.renderConsole(viewer.session, page));
}

export function registerCallPages(
  app: Hono<IdentityEnvironment>,
  dependencies: ActionsPagesDependencies,
): void {
  app.get(UNEXPECTED_PATH, (context) => showUnexpected(context, dependencies));
  app.get(`${CREATE_PATH}/:id/calls`, (context) =>
    showHistory(context, dependencies, context.req.param('id')),
  );
}
