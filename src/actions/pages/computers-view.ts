/**
 * What the Computers page and the console's navigation read (ACT-5): every
 * target summarised, with its vault item's name (ACT-4, metadata only, read
 * in parallel), the agents granted it (ACT-9) and its last call (ACT-63).
 * Reads only.
 */
import { lastCall } from './calls-view.ts';
import { type ComputerKind, KIND_ORDER, KINDS } from './kinds.ts';
import { CREATE_PATH, NEW_PATH } from './paths.ts';
import { summarise } from './summary.ts';
import { activeGrants, clientNames, describeItem } from './view.ts';

import type { ComputerRow, ComputersView } from './computers.ts';
import type { ActionsPagesDependencies } from './view.ts';
import type { ConsoleNavigation, NavChild } from '../../identity/index.ts';

/**
ACT-4, ACT-54: the two reasons `describeItem` gives in place of a name.
*/
const NO_SUCH_ITEM = 'no such item in the vault';
const ITEM_UNCHECKED = 'the item could not be checked';

async function computerRows(
  dependencies: ActionsPagesDependencies,
  operatorId: string,
): Promise<readonly ComputerRow[]> {
  const names = clientNames(dependencies.listClients(operatorId));
  const targets = dependencies.targets.list();
  return Promise.all(
    targets.map(async (target) => {
      const itemName = await describeItem(dependencies.vault, target.credential.item_id);
      const call = lastCall(dependencies.database, target.id);
      return {
        id: target.id,
        name: target.name,
        description: target.description,
        summary: summarise(target),
        itemName,
        isItemMissing: itemName === NO_SUCH_ITEM || itemName.startsWith(ITEM_UNCHECKED),
        problems: target.problems,
        agents: activeGrants(target, names).map((grant) => ({
          clientId: grant.clientId,
          name: grant.clientName,
        })),
        lastCall:
          call === undefined ? undefined : { at: Date.parse(call.at), outcome: call.outcome },
      };
    }),
  );
}

export async function computersView(
  dependencies: ActionsPagesDependencies,
  operatorId: string,
  filter: ComputerKind | undefined,
): Promise<ComputersView> {
  return {
    rows: await computerRows(dependencies, operatorId),
    filter,
    now: dependencies.now(),
  };
}

/**
 * ACT-5: the console's Computers entry with one child per kind present and
 * the "Add computer" action. Counts only; the vault is not read here.
 */
export function navigation(dependencies: ActionsPagesDependencies): ConsoleNavigation {
  const kinds = dependencies.targets.list().map((target) => summarise(target).kind);
  const children: NavChild[] = KIND_ORDER.flatMap((kind) => {
    const count = kinds.filter((each) => each === kind).length;
    return count === 0
      ? []
      : [{ label: KINDS[kind].plural, href: `${CREATE_PATH}?kind=${kind}`, count, kind }];
  });
  return {
    items: [
      {
        key: 'computers',
        label: 'Connections',
        href: CREATE_PATH,
        icon: 'server',
        count: kinds.length,
        children,
      },
    ],
    primaryAction: { label: 'Add connection', href: NEW_PATH },
  };
}
