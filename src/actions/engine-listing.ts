/**
 * `actions_list_targets` (ACT-19): only granted, enabled targets of enabled
 * connectors that the caller's scopes can reach, with `operations` computed
 * from the policy and the scopes; the output type has no place for a
 * destination, a credential field name or a policy pattern.
 */
import { validateTarget } from './targets-schemas.ts';

import type { ConnectorRegistry } from './connectors/registry.ts';
import type { OperationKind } from './policy.ts';
import type { TargetsRepo } from './targets-repo.ts';
import type { ActionsConfig, ConnectorKind } from '../config/actions.ts';

export interface TargetListing {
  readonly name: string;
  readonly description: string;
  readonly connector: ConnectorKind;
  readonly operations: readonly OperationKind[];
  readonly confirm_writes: boolean;
  readonly engine?: 'mssql' | 'postgres';
  readonly unrestricted?: true;
}

export interface ListingDependencies {
  readonly config: Pick<ActionsConfig, 'enabled' | 'connectors'>;
  readonly targets: Pick<TargetsRepo, 'listGranted'>;
  readonly connectors: ConnectorRegistry;
}

export function listTargets(
  dependencies: ListingDependencies,
  caller: { readonly clientId: string; readonly scopes: readonly string[] },
): readonly TargetListing[] {
  if (!dependencies.config.enabled) {
    return [];
  }
  const listings: TargetListing[] = [];
  for (const row of dependencies.targets.listGranted(caller.clientId)) {
    const connector = dependencies.config.connectors[row.connector]
      ? dependencies.connectors.get(row.connector)
      : undefined;
    const target = validateTarget(row);
    if (connector === undefined || target.state === 'invalid' || !row.enabled) {
      continue;
    }
    const capabilities = connector.capabilities(
      target.documents.destination,
      target.documents.policy,
    );
    const operations = [
      ...new Set(
        capabilities.operations
          .filter((grant) => caller.scopes.includes(grant.scope))
          .map((grant) => grant.operation),
      ),
    ];
    if (operations.length === 0) {
      continue;
    }
    listings.push({
      name: row.name,
      description: row.description,
      connector: row.connector,
      operations,
      confirm_writes: target.documents.common.confirm_writes,
      ...(capabilities.engine !== undefined && { engine: capabilities.engine }),
      ...(capabilities.unrestricted === true && { unrestricted: true }),
    });
  }
  return listings;
}
