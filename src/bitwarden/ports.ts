import { createServer } from 'node:net';

/**
 * Asks the kernel for a free loopback port by binding port 0 and releasing it
 * (VAULT-1). `bw serve` then binds the same number; the race window is
 * accepted because a lost race surfaces as a failed start-up attempt, which
 * the supervisor retries.
 */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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
