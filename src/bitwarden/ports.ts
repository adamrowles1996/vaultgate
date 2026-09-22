import { createServer } from 'node:net';

import type { AddressInfo } from 'node:net';

/**
The slice of `net.Server` port allocation needs; tests inject a fake.
*/
export interface ListeningServer {
  once(event: 'error', listener: (error: Error) => void): this;
  listen(port: number, host: string, listening: () => void): this;
  address(): AddressInfo | string | null;
  close(closed: () => void): this;
}

/**
 * Asks the kernel for a free loopback port by binding port 0 and releasing it
 * (VAULT-1). `bw serve` then binds the same number; the race window is
 * accepted because a lost race surfaces as a failed start-up attempt, which
 * the supervisor retries.
 */
export function allocateLoopbackPort(
  newServer: () => ListeningServer = () => createServer(),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = newServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) {
          reject(new Error('could not determine the allocated port'));
          return;
        }
        resolve(port);
      });
    });
  });
}
