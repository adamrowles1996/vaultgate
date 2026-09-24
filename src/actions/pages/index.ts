/**
 * The Computers pages and what they add to identity's console (spec
 * §13.3.2, ACT-5), built by the composition layer only when the layer is
 * enabled (ACT-73): the sub-application of `/account/actions/*` mounted
 * beside the identity routes, the Computers entry of the navigation, the
 * grant matrix of the Agents page, the recent calls of the Activity page and
 * the per-agent computers row the OAuth layer's cards show. Identity and the
 * OAuth layer never import this module (ACT-70); they receive renderers.
 */
import { recentCalls, countUnexpectedSince } from './calls-view.ts';
import { activitySection } from './calls.ts';
import { type ClientTargets, createClientTargets } from './client-grants.ts';
import { navigation } from './computers-view.ts';
import { grantMatrix } from './grant-matrix.ts';
import { kindOf } from './kinds.ts';
import { createActionsRoutes } from './routes.ts';
import { type ActionsPagesDependencies, clientNames } from './view.ts';

import type {
  ConsoleSectionRenderer,
  IdentityEnvironment,
  NavigationProvider,
} from '../../identity/index.ts';
import type { Hono } from 'hono';

export type { ActionsPagesDependencies } from './view.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActionsPages {
  readonly routes: Hono<IdentityEnvironment>;
  /**
  ACT-5: the console's Computers entry, its "Add computer" action and the Activity badge.
  */
  readonly navigation: NavigationProvider;
  /**
  ACT-9: who may use what, on the Agents page.
  */
  readonly agentsSection: ConsoleSectionRenderer;
  /**
  ACT-63: the latest calls across computers, on the Activity page.
  */
  readonly activitySection: ConsoleSectionRenderer;
  /**
  ACT-9: the computers row the OAuth layer's agent cards show.
  */
  readonly clientTargets: ClientTargets;
}

function matrix(dependencies: ActionsPagesDependencies): ConsoleSectionRenderer {
  return (session) => {
    const computers = dependencies.targets.list().map((target) => ({
      id: target.id,
      name: target.name,
      kind: kindOf(target),
      granted: new Set(
        target.grants
          .filter((grant) => grant.revokedAt === undefined)
          .map((grant) => grant.clientId),
      ),
    }));
    return grantMatrix({
      csrfToken: session.csrfToken,
      isReauthenticated: session.isReauthenticated,
      computers,
      clients: dependencies.listClients(session.operatorId),
    });
  };
}

function activity(dependencies: ActionsPagesDependencies): ConsoleSectionRenderer {
  return (session) => {
    const live = new Set(dependencies.targets.list().map((target) => target.id));
    const names = clientNames(dependencies.listClients(session.operatorId));
    const calls = recentCalls(dependencies.database, live, names).calls;
    const since = dependencies.now() - WEEK_MS;
    return activitySection(calls, countUnexpectedSince(dependencies.database, since));
  };
}

export function createActionsPages(dependencies: ActionsPagesDependencies): ActionsPages {
  return {
    routes: createActionsRoutes(dependencies),
    navigation: () => navigation(dependencies),
    agentsSection: matrix(dependencies),
    activitySection: activity(dependencies),
    clientTargets: createClientTargets(dependencies),
  };
}
