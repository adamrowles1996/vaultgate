import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF, actionsEnabled } from '../../test-support/actions-config.ts';
import { createEchoConnector } from '../../test-support/fake-connector.ts';

import { CONNECTOR_LOADERS, connectorRegistry, loadConnectors, schemasFor } from './registry.ts';

describe('connector registry', () => {
  it('ACT-73 loads the runtime of an enabled connector only, and nothing while the layer is off', async () => {
    const loaded: string[] = [];
    const loaders = {
      http: () => {
        loaded.push('http');
        return Promise.resolve(createEchoConnector());
      },
      sql: () => {
        loaded.push('sql');
        return Promise.resolve(createEchoConnector());
      },
    };
    const registry = await loadConnectors(actionsEnabled(['http', 'ssh']), loaders);
    expect(registry.kinds).toStrictEqual(['http']);
    expect(loaded).toStrictEqual(['http']);
    expect(registry.get('http')?.kind).toBe('http');
    expect(registry.get('sql')).toBeUndefined();
    expect(registry.forTool('http_request')?.kind).toBe('http');
    expect(registry.forTool('sql_query')).toBeUndefined();
    const connectorOnly = { ...ACTIONS_OFF, connectors: { ...ACTIONS_OFF.connectors, http: true } };
    const withoutMaster = await loadConnectors(connectorOnly, loaders);
    expect(withoutMaster.kinds).toStrictEqual([]);
    expect(loaded).toStrictEqual(['http']);
  });

  it('ACT-73 ACT-72 loads the http and sql runtimes in production when their switches are on, and no other connector before its milestone', async () => {
    expect(Object.keys(CONNECTOR_LOADERS)).toStrictEqual(['http', 'sql']);
    const everything = actionsEnabled(['http', 'sql', 'ssh', 'winrm', 'browser']);
    const production = await loadConnectors(everything);
    expect(production.kinds).toStrictEqual(['http', 'sql']);
    expect(production.tools.map((tool) => tool.name)).toStrictEqual(['http_request', 'sql_query']);
    expect(production.forTool('http_request')?.kind).toBe('http');
    expect(production.forTool('sql_query')?.kind).toBe('sql');
    const withoutHttp = await loadConnectors(actionsEnabled(['winrm', 'ssh']));
    expect(withoutHttp.kinds).toStrictEqual([]);
  });

  it('14.1 knows the http and sql schemas in every build and no other connector before its milestone', () => {
    expect(schemasFor('http')?.kind).toBe('http');
    expect(schemasFor('sql')?.kind).toBe('sql');
    expect(schemasFor('ssh')).toBeUndefined();
    expect(connectorRegistry([]).kinds).toStrictEqual([]);
  });
});
