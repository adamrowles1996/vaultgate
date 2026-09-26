/**
 * The engine's own dependencies and the context every step of a call reads
 * (spec §13.15), in a module of their own so the steps a call is split into
 * (`engine-many.ts`, `engine-services.ts`) and the engine itself import one
 * set of types without importing each other.
 */
import type { Confirmations, ConfirmationRequest } from './confirm.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import type { ListingDependencies } from './engine-listing.ts';
import type { ResolveDependencies } from './engine-resolve.ts';
import type { ActionError } from './errors.ts';
import type { ActionLimits } from './limits.ts';
import type { TargetsRepo } from './targets-repo.ts';
import type { AuditSink } from '../audit/event.ts';
import type { ActionsConfig } from '../config/actions.ts';
import type { Logger } from '../logger.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { VaultClient } from '../vault/client.ts';
import type { DatabaseSync } from 'node:sqlite';

export type CallOutcome =
  | { readonly kind: 'ok'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'error'; readonly error: ActionError }
  | {
      readonly kind: 'confirmation_required';
      readonly request: ConfirmationRequest;
      readonly requestState: string;
    };

export interface EngineDependencies {
  readonly config: ActionsConfig;
  readonly database: DatabaseSync;
  readonly vault: VaultClient;
  readonly connectors: ConnectorRegistry;
  readonly lookup: Lookup;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly secretKey: Buffer;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly random: (bytes: number) => Buffer;
  readonly newId: () => string;
}

export interface EngineContext extends EngineDependencies {
  readonly confirmations: Confirmations;
  readonly limits: ActionLimits;
  readonly resolve: ListingDependencies & ResolveDependencies;
  readonly repo: TargetsRepo;
}
