/**
 * Who is calling (spec §13.6.1): what the MCP layer knows about the token
 * and the request, what the client declared about elicitation (ACT-48), and
 * the answer to an earlier confirmation request when the call is the retry
 * of ACT-45. The MCP tools build one per `tools/call`; the engine never
 * looks further up.
 */
import type { ElicitResult } from './confirm.ts';

/**
The retried call's answer to a confirmation request (ACT-45).
*/
export interface ConfirmationInput {
  readonly requestState: string;
  readonly result: ElicitResult;
}

export interface Caller {
  readonly clientId: string;
  readonly clientName: string;
  readonly tokenPrefix: string;
  /**
  The token's effective scopes (held and enabled).
  */
  readonly scopes: readonly string[];
  readonly requestId: string;
  readonly ip: string;
  /**
  ACT-48: what the client declared; `none` refuses a confirmed target before anything else happens.
  */
  readonly elicitation: 'form' | 'none';
  readonly confirmation?: ConfirmationInput | undefined;
}
