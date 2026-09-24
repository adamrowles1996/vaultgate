/**
 * The account-page Actions section and its routes (spec §13.3.2, ACT-5),
 * built by the composition layer only when the layer is enabled (ACT-73):
 * the section renderer identity calls when it renders `/account`, and the
 * sub-application of `/account/actions/*` mounted beside the identity routes.
 * Identity never imports this module (ACT-70); it receives the renderer.
 */
import { type ClientTargets, createClientTargets } from './client-grants.ts';
import { createActionsRoutes } from './routes.ts';
import { renderActionsSection } from './section.ts';
import { type ActionsPagesDependencies, sectionView } from './view.ts';

import type { AccountSectionRenderer, IdentityEnvironment } from '../../identity/index.ts';
import type { Hono } from 'hono';

export type { ActionsPagesDependencies } from './view.ts';

export interface ActionsPages {
  readonly section: AccountSectionRenderer;
  readonly routes: Hono<IdentityEnvironment>;
  /**
  ACT-9: the per-client grants cell the OAuth layer's connected-clients list injects.
  */
  readonly clientTargets: ClientTargets;
}

export function createActionsPages(dependencies: ActionsPagesDependencies): ActionsPages {
  return {
    section: (session) => renderActionsSection(sectionView(dependencies, session.operatorId)),
    routes: createActionsRoutes(dependencies),
    clientTargets: createClientTargets(dependencies),
  };
}
