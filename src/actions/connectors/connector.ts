/**
 * The connector interface (spec §14.1). A connector is the protocol behind a
 * target: it owns the shape of the three target documents, says which vault
 * fields a mapping needs and which hosts a destination names, exposes its
 * tools, classifies an operation against the policy without I/O
 * (`authorize`, ACT-78) and runs it with the injected values the engine hands
 * it for the duration of `run` only (ACT-50). Output is raw: the engine
 * scrubs it (ACT-51) and cuts it at the cap (ACT-52).
 */
import type { Endpoint, RunContext, TargetDocuments } from './context.ts';
import type { ConnectorOutput, OperationDescription } from './output.ts';
import type { ConnectorControl, ConnectorServices } from './stateful.ts';
import type { ConnectorTool, TargetCapabilities } from './tool.ts';
import type { ConnectorKind } from '../../config/actions.ts';
import type { Result } from '../../result.ts';
import type { ActionError } from '../errors.ts';
import type { PolicyDecision } from '../policy.ts';
import type { z } from 'zod';

export type {
  Endpoint,
  PinnedEndpoint,
  RunContext,
  RunSupport,
  TargetDocuments,
} from './context.ts';
export type { ConnectorOutput, OperationDescription } from './output.ts';
export type {
  ConnectorControl,
  ConnectorServices,
  SavedTarget,
  StoredTarget,
  TargetAccess,
} from './stateful.ts';
export type { ConnectorTool, OperationSchema, RepoArgument, TargetCapabilities } from './tool.ts';

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
