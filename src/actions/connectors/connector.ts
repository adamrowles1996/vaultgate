/**
 * The connector interface (spec §14.1). A connector is the protocol behind a
 * target: it owns the shape of the three target documents, says which vault
 * fields a mapping needs and which hosts a destination names, exposes its
 * tools, classifies an operation against the policy without I/O
 * (`authorize`, ACT-78) and runs it with the injected values the engine hands
 * it for the duration of `run` only (ACT-50). Output is raw: the engine
 * scrubs it (ACT-51) and cuts it at the cap (ACT-52).
 */
import type { ConnectorKind } from '../../config/actions.ts';
import type { Logger } from '../../logger.ts';
import type { OutputSchema, ToolAnnotations } from '../../mcp/tools/definition.ts';
import type { Result } from '../../result.ts';
import type { ActionScope } from '../../scopes/registry.ts';
import type { ActionError } from '../errors.ts';
import type { CommonPolicy, OperationKind, PolicyDecision } from '../policy.ts';
import type { InjectedValues } from '../scrub.ts';
import type { z } from 'zod';

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
  ACT-43: the host and, where relevant, the database, base path or origin. Never a credential.
  */
  summariseDestination(destination: Destination): string;
}

/**
 * The operation half of a tool's arguments: a strict object, so the MCP layer
 * can put `target` in front of its shape when it advertises the tool (ACT-16)
 * and the engine can parse the arguments minus `target` with it.
 */
export type OperationSchema<Operation> = z.ZodObject<z.ZodRawShape, z.core.$strict> &
  z.ZodType<Operation>;

/**
 * One MCP tool a connector serves (spec §13.6): the name and scope the gate
 * checks, the LLM-facing description of ACT-17, the annotations of the
 * 13.6.1 table (ACT-18), the operation arguments and the strict result shape
 * (ACT-15). `src/mcp/tools/actions.ts` registers every tool of every loaded
 * connector and dispatches its calls to the engine; a connector adds a tool
 * by declaring one of these.
 */
export interface ConnectorTool<Operation> {
  readonly name: string;
  readonly scope: ActionScope;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  /**
  The tool's arguments minus `target` (and `session_id`), strict.
  */
  readonly inputSchema: OperationSchema<Operation>;
  /**
  What the engine returns for the tool, strict; never a place for a credential.
  */
  readonly outputSchema: OutputSchema;
}

export interface OperationGrant {
  readonly operation: OperationKind;
  readonly scope: ActionScope;
}

/**
What `actions_list_targets` may say about a target (ACT-19), before the scope filter.
*/
export interface TargetCapabilities {
  readonly operations: readonly OperationGrant[];
  readonly engine?: 'mssql' | 'postgres';
  readonly unrestricted?: boolean;
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
}

export interface RunContext<Destination, Credential, Policy> extends TargetDocuments<
  Destination,
  Credential,
  Policy
> {
  readonly common: CommonPolicy;
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

export interface OperationDescription {
  /**
  ACT-43: the method and path, the statement or command (first 1 KiB), or the page URL and element.
  */
  readonly summary: string;
  /**
  ACT-60: the SQL class, the HTTP method, `command`, or the browser page URL.
  */
  readonly classification: string;
}

export interface ConnectorOutput {
  /**
  The tool result before scrubbing; every string inside is scrubbed by the engine.
  */
  readonly result: Readonly<Record<string, unknown>>;
  /**
  Byte streams captured up to `maxBytes + guardBytes` (`body`, `stdout`, `stderr`, `snapshot`); the
  engine scrubs and cuts each and writes the text into `result` under the same key.
  */
  readonly captured: Readonly<Record<string, Buffer>>;
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
  authorize(policy: Policy, operation: Operation, credential: Credential): PolicyDecision;
  describe(operation: Operation): OperationDescription;
  /**
  Runs one operation with the injected values; output is raw, the engine scrubs it.
  */
  run(
    context: RunContext<Destination, Credential, Policy>,
    operation: Operation,
  ): Promise<Result<ConnectorOutput, ActionError>>;
}

export type AnyConnectorSchemas = ConnectorSchemas<unknown, unknown, unknown>;

export type AnyConnector = Connector<unknown, unknown, unknown, unknown>;
