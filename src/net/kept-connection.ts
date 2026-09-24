/**
 * Connections that outlive one request, for the protocols that authenticate a
 * socket rather than a message.
 *
 * NTLM is one: the challenge a destination issues can only be answered on the
 * connection it was issued on, and every sealed message afterwards is numbered
 * against state that connection holds (MS-NLMP 3.4, MS-WSMV 3.1.4.1.11). A
 * `winrm` session therefore pins itself to one socket for its six exchanges
 * and releases it when the shell is deleted.
 *
 * The agent is also where a certificate pin has to live. Node ignores a
 * `createConnection` passed in request options once a request has an agent —
 * and `agent: false` gives it one anyway, a fresh default agent whose sockets
 * the system store verifies — so a pin expressed that way silently does
 * nothing. Expressing it as an agent of our own is what makes ACT-57 take
 * effect on the wire.
 */
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { pinnedConnection, type CertificateCheck, type TlsConnect } from './certificate-pin.ts';

import type { Agent, AgentOptions } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ConnectionPlan {
  /**
  ACT-55: the address the engine resolved and validated; the socket goes here.
  */
  readonly address: string;
  readonly port: number;
  /**
  ACT-55: the URL's host name, kept for SNI and for the certificate check.
  */
  readonly servername: string;
  readonly isTls: boolean;
  /**
  ACT-57: the pin that replaces the system store, or `undefined` to let the store verify.
  */
  readonly check: CertificateCheck | undefined;
}

/**
 * An agent whose sockets are the corked, pin-checked TLS connections of
 * `certificate-pin.ts`. Overriding `createConnection` is the one place Node
 * consults for a custom socket once an agent is in play.
 */
class PinnedAgent extends HttpsAgent {
  readonly #open: () => Duplex;

  constructor(options: AgentOptions, open: () => Duplex) {
    super(options);
    this.#open = open;
  }

  override createConnection(): Duplex {
    return this.#open();
  }
}

/**
The agent a request needs: plain, TLS verified by the system store, or TLS judged by a pin.
*/
export function agentFor(connect: TlsConnect, plan: ConnectionPlan, options: AgentOptions): Agent {
  if (!plan.isTls) {
    return new HttpAgent(options);
  }
  if (plan.check === undefined) {
    return new HttpsAgent(options);
  }
  return new PinnedAgent(
    options,
    pinnedConnection(connect, {
      address: plan.address,
      port: plan.port,
      servername: plan.servername,
      check: plan.check,
    }),
  );
}

/**
 * One socket, held for as long as the caller needs it. The transport fills it
 * on the first request and every request after that travels the same
 * connection; `release` closes it, which is what ends an NTLM session.
 */
export class KeptConnection {
  #agent: Agent | undefined;

  use(make: () => Agent): Agent {
    this.#agent ??= make();
    return this.#agent;
  }

  release(): void {
    this.#agent?.destroy();
    this.#agent = undefined;
  }
}
