/**
 * The two read-only call pages of ACT-63: one target's whole history, 50 at
 * a time with an "older calls" link, and the unexpected-write view across
 * every target. Both need a signed-in operator and nothing more — they
 * change nothing, so the ID-15 window does not apply — and both read through
 * `calls-view.ts`, never SQL.
 */
import { targetCalls, unexpectedCalls } from './calls-view.ts';
import {
  type CallCursor,
  parseCursor,
  renderCallHistoryPage,
  renderUnexpectedPage,
} from './calls.ts';
import { CREATE_PATH, UNEXPECTED_PATH } from './paths.ts';
import { type ActionsPagesDependencies, signedIn } from './view.ts';

import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';
import type { Hono } from 'hono';

const CURSOR_PARAMETER = 'before';

function cursorOf(context: IdentityContext): CallCursor | undefined {
  return parseCursor(context.req.query(CURSOR_PARAMETER));
}

function showUnexpected(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
): Response | Promise<Response> {
  const viewer = signedIn(context);
  if (viewer instanceof Response) {
    return viewer;
  }
  const live = new Set(dependencies.targets.list().map((target) => target.id));
  const page = unexpectedCalls(dependencies.database, live, cursorOf(context));
  return context.html(renderUnexpectedPage(page));
}

function showHistory(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Response | Promise<Response> {
  const viewer = signedIn(context);
  if (viewer instanceof Response) {
    return viewer;
  }
  const target = dependencies.targets.get(id);
  if (target === undefined) {
    return context.notFound();
  }
  const page = targetCalls(dependencies.database, target.id, cursorOf(context));
  return context.html(
    renderCallHistoryPage({ targetId: target.id, targetName: target.name, ...page }),
  );
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
