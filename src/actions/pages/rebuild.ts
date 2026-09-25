/**
 * Rebuild index (ACT-108, ACT-115): the operator's way to throw a Semble
 * connection's snapshots away and build the configured ref again. It needs
 * the operator's session and synchroniser token (ID-18) and not ID-15's
 * re-authentication, because it changes no setting: the build runs in the
 * background under the target's own credential, the page answers at once
 * with a notice, and the build's end is an audit event of its own (ACT-116).
 */
import { targetPath } from './paths.ts';
import { targetPage } from './target-page.ts';
import { type ActionsPagesDependencies, targetPageView, viewerOf } from './view.ts';

import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';
import type { CodeControl } from '../connectors/code/control.ts';
import type { Hono } from 'hono';

const NOTHING_TO_REBUILD =
  'This connection has no index to rebuild: only a Semble connection has one, and only while the ' +
  'code connector is on (VAULTGATE_ACTIONS_ENABLE_CODE).';

/**
 * Not awaited by the request: the build outlives it. Its outcome is recorded
 * by the connector and shown on the target page; a fault never becomes an
 * unhandled rejection.
 */
async function inBackground(code: CodeControl, targetId: string): Promise<void> {
  try {
    await code.refresh(targetId, 'operator', true);
  } catch {
    // Nothing to add: the connector's state and audit trail are the record.
  }
}

async function rebuild(
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
  const { code } = dependencies;
  if (code === undefined || target.connector !== 'code') {
    const extras = { error: NOTHING_TO_REBUILD };
    const view = await targetPageView(dependencies, target, viewerOf(gate.session), extras);
    return context.html(await dependencies.renderConsole(gate.session, targetPage(view)), 400);
  }
  void inBackground(code, target.id);
  return context.redirect(`${targetPath(target.id)}?notice=rebuilding`, 303);
}

export function registerRebuild(
  app: Hono<IdentityEnvironment>,
  dependencies: ActionsPagesDependencies,
): void {
  app.post('/account/actions/:id/rebuild', (context) =>
    rebuild(context, dependencies, context.req.param('id')),
  );
}
