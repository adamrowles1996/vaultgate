/**
 * What the `sql` connector's contract tests run against (ACT-75, ACT-78):
 * the real connector over fake sessions, a granted `sql` target on the
 * fixture login item, and a `RunContext` built by hand so `run` can be
 * driven without the engine.
 */
import { createSqlConnector, type SqlConnector } from '../actions/connectors/sql/index.ts';
import {
  sqlPolicySchema,
  type SqlDestination,
  type SqlPolicy,
} from '../actions/connectors/sql/schemas.ts';

import { actionsEnabled } from './actions-config.ts';
import {
  createActionsHarness,
  OPERATOR_ID,
  PUBLIC_ADDRESS,
  CLIENT_ID,
  type ActionsHarness,
  type HarnessOptions,
} from './actions-fixtures.ts';
import { fakeSqlSessions, type FakeOptions, type FakeSessions } from './fake-sql-session.ts';
import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';
import { recordedSupport, type RecordedSupport } from './run-support.ts';
import { CANARY } from './vault-fixture.ts';

import type { SqlRunContext } from '../actions/connectors/sql/run.ts';
import type { Invocation } from '../actions/engine-resolve.ts';
import type { TargetSummary } from '../actions/targets.ts';

export const SQL_HOST = 'db.example.com';

export interface SqlTargetOverrides {
  readonly name?: string;
  readonly engine?: SqlDestination['engine'];
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly mapping?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly internal?: boolean;
  readonly grantTo?: readonly string[];
}

export function sqlTargetInput(overrides: SqlTargetOverrides = {}): Record<string, unknown> {
  return {
    name: overrides.name ?? 'warehouse',
    description: 'The reporting replica',
    connector: 'sql',
    destination: {
      engine: overrides.engine ?? 'postgres',
      host: SQL_HOST,
      database: 'reporting',
      ...overrides.destination,
    },
    internal: overrides.internal ?? false,
    credential: { item_id: 'item-login', mapping: { ...overrides.mapping } },
    policy: { ...overrides.policy },
    enabled: true,
  };
}

export async function createSqlTarget(
  harness: ActionsHarness,
  overrides: SqlTargetOverrides = {},
): Promise<TargetSummary> {
  const created = unwrapOk(
    await harness.engine.targets.create(sqlTargetInput(overrides), OPERATOR_ID),
  );
  const grantees = overrides.grantTo ?? [CLIENT_ID];
  for (const clientId of grantees) {
    unwrapOk(harness.engine.targets.grant(created.id, clientId, OPERATOR_ID));
  }
  return harness.engine.targets.get(created.id) ?? created;
}

/**
A `sql_query` call on the fixture target; `target` inside the arguments names the target.
*/
export function sqlInvocation(toolArguments: Readonly<Record<string, unknown>> = {}): Invocation {
  const merged = { target: 'warehouse', statement: 'SELECT 1', ...toolArguments };
  return { tool: 'sql_query', target: merged.target, arguments: merged };
}

export function sqlConnectorOver(fake: FakeSessions): SqlConnector {
  return createSqlConnector(fake.sessions);
}

export interface OverSql {
  readonly fake: FakeSessions;
  readonly harness: ActionsHarness;
}

/**
An engine harness whose loaded runtime is the real `sql` connector over fake sessions.
*/
export function harnessOverSql(
  options: FakeOptions = {},
  harnessOptions: Omit<HarnessOptions, 'runtime'> = {},
): OverSql {
  const fake = fakeSqlSessions(options);
  return {
    fake,
    harness: createActionsHarness({
      config: actionsEnabled(['sql']),
      addresses: { [SQL_HOST]: [PUBLIC_ADDRESS] },
      ...harnessOptions,
      runtime: sqlConnectorOver(fake),
    }),
  };
}

export interface SqlContextOptions {
  readonly engine?: SqlDestination['engine'];
  readonly destination?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly secret?: string;
  readonly username?: string | undefined;
  readonly pinned?: SqlRunContext['pinned'];
}

export interface BuiltSqlContext {
  readonly context: SqlRunContext;
  readonly controller: AbortController;
  readonly logged: () => readonly Record<string, unknown>[];
  readonly support: RecordedSupport;
}

/**
A PostgreSQL target on the fixture password with the default policy, unless told otherwise.
*/
export function sqlRunContext(options: SqlContextOptions = {}): BuiltSqlContext {
  const destination: SqlDestination = {
    engine: options.engine ?? 'postgres',
    host: SQL_HOST,
    database: 'reporting',
    tls: 'require',
    trust_server_certificate: false,
    ...options.destination,
  };
  const credential = { username_from: 'login.username', password_field: 'password' };
  const policy: SqlPolicy = sqlPolicySchema.parse({ ...options.policy });
  const username = 'username' in options ? options.username : 'alice@example.com';
  const support = recordedSupport({
    entries: [{ field: 'password', value: Buffer.from(options.secret ?? CANARY.password, 'utf8') }],
    username,
    target: { name: 'warehouse' },
  });
  const controller = new AbortController();
  const { logger, lines } = captureLogger();
  return {
    controller,
    support,
    logged: lines,
    context: {
      destination,
      credential,
      policy,
      common: policy,
      injected: support.secrets.injected,
      support: support.support,
      pinned: options.pinned ?? [{ host: SQL_HOST, tls: true, address: PUBLIC_ADDRESS }],
      signal: controller.signal,
      outputLimit: {
        maxBytes: policy.max_output_bytes,
        get guardBytes() {
          return support.secrets.scrub.guardBytes;
        },
      },
      logger,
    },
  };
}
