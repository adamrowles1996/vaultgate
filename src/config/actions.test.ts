import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF, actionsEnabled } from '../test-support/actions-config.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { actionsWarnings, cdpUrlProblem, cdpUrlSchema, CONNECTOR_KINDS } from './actions.ts';
import { describeConfig, loadConfig } from './index.ts';

const REQUIRED = {
  VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
  VAULTGATE_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

function load(environment: Record<string, string | undefined>): ReturnType<typeof loadConfig> {
  return loadConfig(environment);
}

const PUBLIC_ADDRESS_PROBLEM =
  'must not be a public address; the sidecar is reached on an internal network';

describe('actionsWarnings', () => {
  it('ACT-67 warns once per connector switch set without the master switch, never with it', () => {
    expect(actionsWarnings(ACTIONS_OFF)).toStrictEqual([]);
    expect(
      actionsWarnings({
        ...ACTIONS_OFF,
        connectors: { ...ACTIONS_OFF.connectors, http: true, browser: true },
      }),
    ).toStrictEqual([
      'VAULTGATE_ACTIONS_ENABLE_HTTP is set but VAULTGATE_ENABLE_ACTIONS is false; the http connector stays off',
      'VAULTGATE_ACTIONS_ENABLE_BROWSER is set but VAULTGATE_ENABLE_ACTIONS is false; the browser connector stays off',
    ]);
    expect(actionsWarnings(actionsEnabled(['http']))).toStrictEqual([]);
  });
});

describe('cdpUrlProblem', () => {
  it('13.14 accepts a ws:// or wss:// URL on a private, loopback or named host and nothing else', () => {
    expect(cdpUrlProblem('ws://browser:9222')).toBeUndefined();
    expect(cdpUrlProblem('ws://10.0.0.5:9222/devtools/browser/x')).toBeUndefined();
    expect(cdpUrlProblem('wss://[::1]:9222')).toBeUndefined();
    expect(cdpUrlProblem('ws://93.184.216.34:9222')).toBe(PUBLIC_ADDRESS_PROBLEM);
    expect(cdpUrlProblem('https://browser:9222')).toBe('must be a ws:// or wss:// URL');
    expect(cdpUrlProblem('not a url')).toBe('must be a ws:// or wss:// URL');
    expect(CONNECTOR_KINDS).toStrictEqual(['http', 'sql', 'ssh', 'winrm', 'browser']);
  });

  it('13.14 the schema is optional and carries the problem as its issue', () => {
    expect(cdpUrlSchema.parse(undefined)).toBeUndefined();
    expect(cdpUrlSchema.parse('ws://browser:9222')).toBe('ws://browser:9222');
    const failed = cdpUrlSchema.safeParse('ws://8.8.8.8');
    expect(failed.success).toBe(false);
    expect(failed.error?.issues.map((issue) => issue.message)).toStrictEqual([
      PUBLIC_ADDRESS_PROBLEM,
    ]);
  });
});

describe('actions configuration', () => {
  it('ACT-68 CFG-3 reads the eight actions variables into config.actions and lists them in the summary', () => {
    const { config, warnings } = unwrapOk(
      load({
        ...REQUIRED,
        VAULTGATE_ENABLE_ACTIONS: 'true',
        VAULTGATE_ACTIONS_ENABLE_HTTP: 'true',
        VAULTGATE_ACTIONS_ENABLE_SQL: 'true',
        VAULTGATE_ACTIONS_ENABLE_SSH: 'true',
        VAULTGATE_ACTIONS_ENABLE_WINRM: 'true',
        VAULTGATE_ACTIONS_ENABLE_BROWSER: 'true',
        VAULTGATE_ACTIONS_BROWSER_CDP_URL: 'ws://browser:9222',
        VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND: 'true',
      }),
    );
    const actions = {
      enabled: true,
      connectors: { http: true, sql: true, ssh: true, winrm: true, browser: true },
      browserCdpUrl: 'ws://browser:9222',
      allowAnyCommand: true,
    };
    expect(config.actions).toStrictEqual(actions);
    expect(describeConfig(config)['actions']).toStrictEqual(actions);
    expect(warnings).toStrictEqual([]);
  });

  it('ACT-67 warns at start-up about a connector switch without the master switch', () => {
    const { warnings } = unwrapOk(load({ ...REQUIRED, VAULTGATE_ACTIONS_ENABLE_SQL: 'true' }));
    expect(warnings).toStrictEqual([
      'VAULTGATE_ACTIONS_ENABLE_SQL is set but VAULTGATE_ENABLE_ACTIONS is false; the sql connector stays off',
    ]);
  });

  it('13.14 requires VAULTGATE_ACTIONS_BROWSER_CDP_URL with the browser connector and refuses a public one', () => {
    const missing = unwrapFail(
      load({
        ...REQUIRED,
        VAULTGATE_ENABLE_ACTIONS: 'true',
        VAULTGATE_ACTIONS_ENABLE_BROWSER: 'true',
      }),
    );
    expect(missing.issues).toStrictEqual([
      'VAULTGATE_ACTIONS_BROWSER_CDP_URL: is required when VAULTGATE_ACTIONS_ENABLE_BROWSER is true',
    ]);
    const publicUrl = unwrapFail(
      load({ ...REQUIRED, VAULTGATE_ACTIONS_BROWSER_CDP_URL: 'wss://93.184.216.34:9222' }),
    );
    expect(publicUrl.issues).toStrictEqual([
      'VAULTGATE_ACTIONS_BROWSER_CDP_URL: must not be a public address; the sidecar is reached on an internal network',
    ]);
  });
});
