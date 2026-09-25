/**
 * The connector interface (spec §14.1). A connector is the protocol behind a
 * target: it owns the shape of the three target documents, says which vault
 * fields a mapping needs and which hosts a destination names, exposes its
 * tools, classifies an operation against the policy without I/O
 * (`authorize`, ACT-78) and runs it with the injected values the engine hands
 * it for the duration of `run` only (ACT-50). Output is raw: the engine
 * scrubs it (ACT-51) and cuts it at the cap (ACT-52).
 */
import type { ConnectorOutput, OperationDescription } from './output.ts';
import type { ConnectorTool, TargetCapabilities } from './tool.ts';
import type { ConnectorKind } from '../../config/actions.ts';
import type { Logger } from '../../logger.ts';
import type { Result } from '../../result.ts';
import type { ActionsAuditSink } from '../audit.ts';
import type { ActionError } from '../errors.ts';
import type { CommonPolicy, PolicyDecision } from '../policy.ts';
import type { InjectedValues } from '../scrub.ts';
import type { z } from 'zod';

export type { ConnectorOutput, OperationDescription } from './output.ts';
export type {
  ConnectorTool,
  OperationGrant,
  OperationSchema,
  RepoArgument,
  TargetCapabilities,
} from './tool.ts';

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

/**
 * A vault field a credential mapping needs: the marker name, the selector
 * (`src/vault/fields.ts`) and its role. A `secret` becomes an injected value;
 * the `username` (at most one, `login.username` or any selector) feeds the
 * `basic` injection mode and the `basic` scrub variant.
 */
export interface CredentialField {
  readonly name: string;
  readonly selector: string;
  readonly role: 'secret' | 'username';
}

export interface TargetDocuments<Destination, Credential, Policy> {
  readonly destination: Destination;
  readonly credential: Credential;
  readonly policy: Policy;
}

/**
 * What a connector judges an operation against: the target's three documents
 * and the tool the agent called. A connector that serves more than one tool
 * (`sql`) needs the name — `sql_query` may only ever read, whatever the
 * statement classifies as — and the destination says which dialect or
 * protocol the operation is written in (ACT-36).
 */
export interface OperationRequest<Destination, Credential, Policy> extends TargetDocuments<
  Destination,
  Credential,
  Policy
> {
  readonly tool: string;
}

/**
 * The static half of a connector: what the targets service needs to validate
 * and describe a target of this kind, present in every build so the account
 * page can edit targets of a connector whose runtime is not loaded.
 */
export interface ConnectorSchemas<Destination, Credential, Policy> {
  readonly kind: ConnectorKind;
  readonly destinationSchema: z.ZodType<Destination>;
  readonly credentialSchema: z.ZodType<Credential>;
  readonly policySchema: z.ZodType<Policy>;
  endpoints(destination: Destination): readonly Endpoint[];
  credentialFields(credential: Credential): readonly CredentialField[];
  /**
  Save-time checks beyond the schemas (ACT-79, ACT-81); each problem is shown to the operator.
  */
  saveProblems(documents: TargetDocuments<Destination, Credential, Policy>): readonly string[];
  /**
   * ACT-51: the login name of the `base64(username:secret)` variant, when this
   * connector authenticates with one and the destination holds the name rather
   * than the vault (`winrm`). A connector whose mapping names a `username`
   * field leaves this out — the engine already has that name — and so does one
   * that never builds such a string, `ssh` among them: its protocol sends the
   * login name and the secret as separate fields, so vaultgate creates no pair
   * for a destination to echo.
   */
  basicUsername?(destination: Destination): string | undefined;
  /**
  ACT-43: the host and, where relevant, the database, base path or origin. Never a credential.
  */
  summariseDestination(destination: Destination): string;
  /**
   * ACT-49: whether the policy permits an operation that is not a read, so
   * the account page knows whether `confirm_writes` is in force for this
   * target and can say so when the operator turns it off.
   */
  allowsNonRead(policy: Policy): boolean;
  /**
  ACT-103: the problem a save reports for `internal: true`, for a connector whose destinations never are.
  */
  readonly internalRefused?: string;
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
What a stateful connector answers to the engine, the targets service and the pages.
*/
export interface ConnectorControl {
  /**
  ACT-108: a target was created, enabled, disabled or changed; `previous` holds its documents before a change.
  */
  saved(targetId: string, previous: TargetDocuments<unknown, unknown, unknown> | undefined): void;
  /**
  ACT-109: a target is about to be deleted.
  */
  removed(targetId: string): void;
  /**
  ACT-115: false once the connector found itself unable to serve (an incompatible sidecar); its tools go.
  */
  available(): boolean;
}

export interface Connector<Destination, Credential, Policy, Operation> extends ConnectorSchemas<
  Destination,
  Credential,
  Policy
> {
  readonly tools: readonly ConnectorTool<Operation>[];
  capabilities(destination: Destination, policy: Policy): TargetCapabilities;
  /**
   * Pure: classifies and checks the operation against the policy; no I/O
   * (ACT-78). The credential document says which injection point the
   * mapping owns, so an operation that would set it is refused (ACT-22).
   */
  authorize(
    request: OperationRequest<Destination, Credential, Policy>,
    operation: Operation,
  ): PolicyDecision;
  describe(
    request: OperationRequest<Destination, Credential, Policy>,
    operation: Operation,
  ): OperationDescription;
  /**
  Runs one operation with the injected values; output is raw, the engine scrubs it.
  */
  run(
    context: RunContext<Destination, Credential, Policy>,
    operation: Operation,
  ): Promise<Result<ConnectorOutput, ActionError>>;
  /**
  ACT-110: one operation over several targets at once, for a tool with a `repo` argument.
  */
  runMany?(
    contexts: readonly RunContext<Destination, Credential, Policy>[],
    operation: Operation,
  ): Promise<Result<ConnectorOutput, ActionError>>;
  /**
  ACT-16, ACT-110: the decision over every target of such a call together, once each has passed `authorize`.
  */
  authorizeMany?(
    requests: readonly OperationRequest<Destination, Credential, Policy>[],
    operation: Operation,
  ): PolicyDecision;
  /**
  A connector that keeps state between calls is given the engine's services once.
  */
  attach?(services: ConnectorServices): ConnectorControl;
}

export type AnyConnectorSchemas = ConnectorSchemas<unknown, unknown, unknown>;

export type AnyConnector = Connector<unknown, unknown, unknown, unknown>;
