/**
 * What a connector is given for one run (spec §14.1): the target's documents,
 * the pinned endpoints (ACT-55), the engine's run support (ACT-51, ACT-83)
 * and the output limit (ACT-52). Re-exported by `./connector.ts`.
 */
import type { Logger } from '../../logger.ts';
import type { Result } from '../../result.ts';
import type { ActionError } from '../errors.ts';
import type { CommonPolicy } from '../policy.ts';
import type { InjectedValues } from '../scrub.ts';

/**
One host a destination names and whether the transport to it is encrypted (ACT-57).
*/
export interface Endpoint {
  readonly host: string;
  readonly tls: boolean;
}

/**
An endpoint with the address the engine resolved and validated once for this call (ACT-55).
*/
export interface PinnedEndpoint extends Endpoint {
  readonly address: string;
}

export interface TargetDocuments<Destination, Credential, Policy> {
  readonly destination: Destination;
  readonly credential: Credential;
  readonly policy: Policy;
}

export interface OutputLimit {
  readonly maxBytes: number;
  /**
  ACT-52: capture this many bytes beyond `maxBytes` so a value straddling the cut is still scrubbed.
  */
  readonly guardBytes: number;
}

/**
The target a call runs against, as a connector may name it: the cache key of an adapter token (ACT-82) and the audit subject (ACT-83). Never the vault item id.
*/
export interface CallTarget {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

/**
 * What a connector may ask of the engine during a run, so it never reaches
 * the vault, the resolver or the audit trail itself: a second host resolved
 * under the ACT-55 rules, a secret obtained mid-call added to the scrub table
 * (ACT-51) and zeroed with the rest, and the credential rotation of ACT-83.
 */
export interface RunSupport {
  readonly target: CallTarget;
  /**
  ACT-55: resolves and validates a host beyond the destination, such as the `graph` token endpoint.
  */
  resolve(endpoint: Endpoint): Promise<Result<PinnedEndpoint, ActionError>>;
  /**
  ACT-51: a value obtained during the call joins the scrub table at once; its buffer is zeroed at the end.
  */
  capture(field: string, value: Buffer): void;
  /**
  ACT-83: writes a rotated credential back to the credential's vault item and records the event.
  */
  rotate(field: string, value: string): Promise<Result<void, ActionError>>;
  /**
   * ACT-51, ACT-53: upstream text the connector is about to log rather than
   * return. The engine scrubs everything that leaves it, but a log line the
   * connector writes itself never passes through that, and OPS-1's pino
   * backstop redacts by field name, not by content: this is the one way a
   * driver message reaches the log without the call's scrub table seeing it.
   */
  scrub(text: string): string;
}

export interface RunContext<Destination, Credential, Policy> extends TargetDocuments<
  Destination,
  Credential,
  Policy
> {
  readonly common: CommonPolicy;
  /**
  The tool the agent called; `sql` serves two and runs them differently (ACT-24, ACT-25).
  */
  readonly tool: string;
  readonly injected: InjectedValues;
  readonly support: RunSupport;
  /**
  ACT-55: connect to `address`; `host` is for TLS (SNI, verification), `Host` and host-key lookup only.
  */
  readonly pinned: readonly PinnedEndpoint[];
  /**
  ACT-59: aborted when the policy timeout elapses; the connector cancels its work.
  */
  readonly signal: AbortSignal;
  readonly outputLimit: OutputLimit;
  readonly logger: Logger;
}
