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

import { tlsConnection, type TlsPlan, type TlsConnect } from './certificate-pin.ts';

import type { Agent, AgentOptions } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ConnectionPlan extends TlsPlan {
  readonly isTls: boolean;
}

/**
 * An agent whose sockets are the guarded TLS connections of
 * `certificate-pin.ts`. Overriding `createConnection` is the one place Node
 * consults for a custom socket once an agent is in play, and it is also how
 * the leaf certificate becomes readable at all: the default agent hands back
 * a response and keeps the socket to itself.
 */
class TlsAgent extends HttpsAgent {
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
The agent a request needs: plain, or a TLS socket this module opened and watched itself.
*/
export function agentFor(connect: TlsConnect, plan: ConnectionPlan, options: AgentOptions): Agent {
  return plan.isTls ? new TlsAgent(options, tlsConnection(connect, plan)) : new HttpAgent(options);
}

/**
 * One socket, held for as long as the caller needs it. The transport fills it
 * on the first request and every request after that travels the same
 * connection; `release` closes it, which is what ends an NTLM session.
 *
 * It also remembers the leaf certificate that connection's peer presented,
 * because a protocol that authenticates the socket may need to bind itself to
 * the channel it is authenticating over (RFC 5929) and no later layer can see
 * it.
 */
export class KeptConnection {
  #agent: Agent | undefined;
  #certificate: Buffer | undefined;

  /**
  The peer's leaf certificate, or `undefined` while the connection is plain or unopened.
  */
  get certificate(): Buffer | undefined {
    return this.#certificate;
  }

  /**
  Called by the connection's own socket once the peer has presented a certificate.
  */
  record(certificate: Buffer): void {
    this.#certificate = certificate;
  }

  use(make: () => Agent): Agent {
    this.#agent ??= make();
    return this.#agent;
  }

  release(): void {
    this.#agent?.destroy();
    this.#agent = undefined;
    this.#certificate = undefined;
  }
}
