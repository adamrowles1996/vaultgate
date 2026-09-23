/**
 * Everything an actions test needs: an engine over an in-memory store with
 * the fixture vault, the echo connector, a manual clock and deterministic
 * ids, plus a granted `http` target and a caller with the `actions:http`
 * scope. The next milestones' tools and pages build on the same harness.
 */
import { connectorRegistry } from '../actions/connectors/registry.ts';
import { type ActionsEngine, type CallOutcome, createActionsEngine } from '../actions/engine.ts';
import { listActionCalls, type StoredActionCall } from '../audit/actions-query.ts';
import { run } from '../storage/query.ts';

import { actionsEnabled } from './actions-config.ts';
import { openTestDatabase } from './database.ts';
import { createEchoConnector, type EchoConnector } from './fake-connector.ts';
import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { captureLogger } from './logging.ts';
import { ManualClock } from './manual-clock.ts';
import { unwrapOk } from './result.ts';

import type { Caller } from '../actions/caller.ts';
import type { ConfirmationRequest } from '../actions/confirm.ts';
import type { AnyConnector } from '../actions/connectors/connector.ts';
import type { Invocation } from '../actions/engine-resolve.ts';
import type { ActionError } from '../actions/errors.ts';
import type { TargetSummary } from '../actions/targets.ts';
import type { AuditEvent } from '../audit/event.ts';
import type { ActionsConfig } from '../config/actions.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { DatabaseSync } from 'node:sqlite';

export const CLIENT_ID = 'vg_c_agent';
export const OTHER_CLIENT_ID = 'vg_c_other';
export const OPERATOR_ID = 'operator-1';
export const PUBLIC_ADDRESS = '93.184.216.34';
export const SECRET_KEY = Buffer.alloc(32, 5);

export interface ActionsHarness {
  readonly engine: ActionsEngine;
  readonly database: DatabaseSync;
  readonly vault: InMemoryVaultClient;
  readonly connector: EchoConnector;
  readonly clock: ManualClock;
  readonly audit: AuditEvent[];
  readonly logged: () => readonly Record<string, unknown>[];
  readonly lookups: string[];
}

export interface HarnessOptions {
  readonly config?: ActionsConfig;
  readonly connector?: EchoConnector;
  /**
  A runtime to load instead of the echo connector (the real `http` connector over a fake transport).
  */
  readonly runtime?: AnyConnector;
  /**
  `false` leaves the runtime registry empty (a connector enabled but not loaded, ACT-67).
  */
  readonly loadRuntime?: boolean;
  readonly vault?: InMemoryVaultClient;
  /**
  Answers per host name; anything else resolves to one public address.
  */
  readonly addresses?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
  Where the engine's audit events go; an app test shares the app's trail.
  */
  readonly audit?: AuditEvent[];
  /**
  An open, migrated database shared with the identity harness (the account pages); a fresh one by default.
  */
  readonly database?: DatabaseSync;
}

/**
The `oauth_clients` row a grant references (ACT-9).
*/
export function insertClient(database: DatabaseSync, clientId: string): void {
  run(
    database,
    "INSERT INTO oauth_clients (id, client_id, mode, client_name, redirect_uris, metadata, created_at) VALUES (?, ?, 'dcr', ?, '[]', '{}', 0)",
    `row-${clientId}`,
    clientId,
    `Client ${clientId}`,
  );
}

export function createActionsHarness(options: HarnessOptions = {}): ActionsHarness {
  const database = options.database ?? openTestDatabase();
  insertClient(database, CLIENT_ID);
  insertClient(database, OTHER_CLIENT_ID);
  const vault = options.vault ?? new InMemoryVaultClient();
  const connector = options.connector ?? createEchoConnector();
  const clock = new ManualClock();
  const audit = options.audit ?? [];
  const { logger, lines } = captureLogger();
  const lookups: string[] = [];
  const lookup: Lookup = (hostname) => {
    lookups.push(hostname);
    return Promise.resolve(options.addresses?.[hostname] ?? [PUBLIC_ADDRESS]);
  };
  let ids = 0;
  let randomCalls = 0;
  const engine = createActionsEngine({
    config: options.config ?? actionsEnabled(['http']),
    database,
    vault,
    connectors: connectorRegistry(
      options.loadRuntime === false ? [] : [options.runtime ?? connector],
    ),
    lookup,
    audit: {
      record: (event) => {
        audit.push(event);
      },
    },
    logger,
    secretKey: SECRET_KEY,
    now: () => clock.now(),
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    random: (bytes) => {
      randomCalls += 1;
      return Buffer.alloc(bytes, randomCalls);
    },
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  });
  return { engine, database, vault, connector, clock, audit, logged: lines, lookups };
}

interface TargetFields {
  readonly name: string;
  readonly description: string;
  readonly base_url: string;
  readonly internal: boolean;
  readonly item_id: string;
  readonly mapping: unknown;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
}

export interface TargetOverrides extends Partial<TargetFields> {
  readonly grantTo?: readonly string[];
}

export const DEFAULT_TARGET: TargetFields = {
  name: 'api',
  description: 'The example API',
  base_url: 'https://api.example.com/v1',
  internal: false,
  item_id: 'item-login',
  mapping: { mode: 'bearer', field: 'password' },
  policy: {},
  enabled: true,
};

/**
The `create` input of an `http` target on the fixture login item, every path allowed unless told otherwise.
*/
export function targetInput(overrides: TargetOverrides = {}): Record<string, unknown> {
  const fields = { ...DEFAULT_TARGET, ...overrides };
  return {
    name: fields.name,
    description: fields.description,
    connector: 'http',
    destination: { base_url: fields.base_url },
    internal: fields.internal,
    credential: { item_id: fields.item_id, mapping: fields.mapping },
    policy: { allowed_paths: ['/**'], ...fields.policy },
    enabled: fields.enabled,
  };
}

/**
Creates the target and grants it to the agent client unless told otherwise.
*/
export async function createHttpTarget(
  harness: ActionsHarness,
  overrides: TargetOverrides = {},
): Promise<TargetSummary> {
  const created = unwrapOk(
    await harness.engine.targets.create(targetInput(overrides), OPERATOR_ID),
  );
  const grantees = overrides.grantTo ?? [CLIENT_ID];
  for (const clientId of grantees) {
    unwrapOk(harness.engine.targets.grant(created.id, clientId, OPERATOR_ID));
  }
  return harness.engine.targets.get(created.id) ?? created;
}

export function caller(overrides: Partial<Caller> = {}): Caller {
  return {
    clientId: CLIENT_ID,
    clientName: 'Agent One',
    tokenPrefix: 'aabbccdd0011',
    scopes: ['vault:read', 'actions:http'],
    requestId: 'req-1',
    ip: '203.0.113.9',
    elicitation: 'form',
    ...overrides,
  };
}

/**
Every `action_calls` row, oldest first.
*/
export function storedCalls(database: DatabaseSync): readonly StoredActionCall[] {
  return listActionCalls(database, {
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
    limit: 1000,
  }).records.toReversed();
}

/**
An `http_request` call on the fixture target; `target` inside the arguments names the target.
*/
export function httpInvocation(toolArguments: Readonly<Record<string, unknown>> = {}): Invocation {
  const merged = { target: 'api', method: 'GET', path: '/v1/me', ...toolArguments };
  return { tool: 'http_request', target: merged.target, arguments: merged };
}

export function errorOf(outcome: CallOutcome): ActionError {
  if (outcome.kind !== 'error') {
    throw new Error(`expected an error but the call ended ${outcome.kind}`);
  }
  return outcome.error;
}

export function resultOf(outcome: CallOutcome): Readonly<Record<string, unknown>> {
  if (outcome.kind !== 'ok') {
    throw new Error(`expected a result but the call ended ${outcome.kind}`);
  }
  return outcome.result;
}

export interface PendingConfirmation {
  readonly request: ConfirmationRequest;
  readonly requestState: string;
}

export function confirmationOf(outcome: CallOutcome): PendingConfirmation {
  if (outcome.kind !== 'confirmation_required') {
    throw new Error(`expected a confirmation request but the call ended ${outcome.kind}`);
  }
  return { request: outcome.request, requestState: outcome.requestState };
}
