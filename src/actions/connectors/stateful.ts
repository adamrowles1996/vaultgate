/**
 * What the engine and a connector that keeps state between calls (`code`)
 * say to each other outside any call (ACT-108, ACT-109, ACT-115): the
 * services the engine lends it once, the target access a build borrows, and
 * what the connector answers about saves, deletions and its own
 * availability. Re-exported by `./connector.ts`.
 */
import type { RunContext, TargetDocuments } from './context.ts';
import type { Logger } from '../../logger.ts';
import type { Result } from '../../result.ts';
import type { ActionsAuditSink } from '../audit.ts';
import type { ActionError } from '../errors.ts';

/**
 * A target's documents, injected values and pinned endpoints lent to a
 * connector outside any call, for the work of ACT-108 that a save or the
 * operator starts; disposed as soon as the work ends.
 */
export type TargetAccess = Omit<
  RunContext<unknown, unknown, unknown>,
  'tool' | 'signal' | 'outputLimit'
>;

/**
What the engine lends a stateful connector (`code`) once, when it is constructed.
*/
export interface ConnectorServices {
  readonly logger: Logger;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly audit: ActionsAuditSink;
  /**
  ACT-108: runs `work` with the target's credential and pinned endpoints; a failure to get them is the error.
  */
  withTarget<T>(
    targetId: string,
    work: (access: TargetAccess) => Promise<T>,
  ): Promise<Result<T, ActionError>>;
  /**
  ACT-109: the ids and revisions of every stored target of the connector.
  */
  targets(): readonly StoredTarget[];
}

export interface StoredTarget {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly documents: TargetDocuments<unknown, unknown, unknown> | undefined;
}

/**
A save as a stateful connector hears of it: the target's switch and its documents after and before.
*/
export interface SavedTarget {
  readonly enabled: boolean;
  /**
  The documents as saved; `undefined` for a stored row that no longer validates (ACT-1).
  */
  readonly current: TargetDocuments<unknown, unknown, unknown> | undefined;
  /**
  The documents before an update, when they validated; `undefined` for a creation or a switch.
  */
  readonly previous: TargetDocuments<unknown, unknown, unknown> | undefined;
}

/**
What a stateful connector answers to the engine, the targets service and the pages.
*/
export interface ConnectorControl {
  /**
  ACT-108: a target was created, enabled, disabled or changed.
  */
  saved(targetId: string, change: SavedTarget): void;
  /**
  ACT-109: a target is about to be deleted.
  */
  removed(targetId: string): void;
  /**
  ACT-115: false once the connector found itself unable to serve (an incompatible sidecar); its tools go.
  */
  available(): boolean;
}
