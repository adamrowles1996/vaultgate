/**
 * The connector registry (ACT-73): the schemas of every connector this
 * build knows, present always so targets can be validated and edited, and
 * the runtimes, imported dynamically at engine construction only for the
 * connectors the configuration enables, so a deployment that never enables
 * a connector never loads its module or its dependencies (ACT-72).
 */
import { CONNECTOR_KINDS, type ActionsConfig, type ConnectorKind } from '../../config/actions.ts';

import { httpSchemas } from './http/schemas.ts';

import type { AnyConnector, AnyConnectorSchemas } from './connector.ts';

export type ConnectorLoader = () => Promise<AnyConnector>;

/**
 * One line per connector milestone (M9: `http`, M11: `sql`, M12: `ssh`,
 * M13: `winrm`, M15: `browser`). No runtime has landed yet, so production
 * loads nothing and the engine's registry is empty; tests inject a fake.
 */
export const CONNECTOR_LOADERS: Partial<Readonly<Record<ConnectorKind, ConnectorLoader>>> = {};

const CONNECTOR_SCHEMAS: Partial<Readonly<Record<ConnectorKind, AnyConnectorSchemas>>> = {
  http: httpSchemas,
};

/**
The schemas of a connector this build can validate targets for, or `undefined` before its milestone.
*/
export function schemasFor(kind: ConnectorKind): AnyConnectorSchemas | undefined {
  return CONNECTOR_SCHEMAS[kind];
}

export interface ConnectorRegistry {
  readonly kinds: readonly ConnectorKind[];
  get(kind: ConnectorKind): AnyConnector | undefined;
  /**
  The connector that owns a tool name (`sql_query` and `sql_execute` both belong to `sql`).
  */
  forTool(tool: string): AnyConnector | undefined;
}

export function connectorRegistry(connectors: readonly AnyConnector[]): ConnectorRegistry {
  const byKind = new Map(connectors.map((connector) => [connector.kind, connector]));
  const byTool = new Map(
    connectors.flatMap((connector) => connector.tools.map((tool) => [tool.name, connector])),
  );
  return {
    kinds: connectors.map((connector) => connector.kind),
    get: (kind) => byKind.get(kind),
    forTool: (tool) => byTool.get(tool),
  };
}

/**
Loads the runtime of every enabled connector that has one (ACT-73).
*/
export async function loadConnectors(
  config: Pick<ActionsConfig, 'enabled' | 'connectors'>,
  loaders: Partial<Readonly<Record<ConnectorKind, ConnectorLoader>>> = CONNECTOR_LOADERS,
): Promise<ConnectorRegistry> {
  const loaded: AnyConnector[] = [];
  for (const kind of CONNECTOR_KINDS) {
    const loader = loaders[kind];
    if (loader !== undefined && config.enabled && config.connectors[kind]) {
      loaded.push(await loader());
    }
  }
  return connectorRegistry(loaded);
}
