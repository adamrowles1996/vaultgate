import { describe, expect, it } from 'vitest';

import { allocateLoopbackPort, type ListeningServer } from './ports.ts';

class FakeServer implements ListeningServer {
  readonly #address: ListeningServer['address'];
  readonly #error: Error | undefined;

  constructor(address: ListeningServer['address'], error?: Error) {
    this.#address = address;
    this.#error = error;
  }

  once(_event: 'error', listener: (error: Error) => void): this {
    const error = this.#error;
    if (error !== undefined) {
      queueMicrotask(() => {
        listener(error);
      });
    }
    return this;
  }

  listen(_port: number, _host: string, listening: () => void): this {
    if (this.#error === undefined) {
      queueMicrotask(listening);
    }
    return this;
  }

  address(): ReturnType<ListeningServer['address']> {
    return this.#address();
  }

  close(closed: () => void): this {
    queueMicrotask(closed);
    return this;
  }
}

describe('allocateLoopbackPort', () => {
  it('VAULT-1 binds port 0 on loopback and returns the kernel-assigned port', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  it('returns the port the server reports once it has been released', async () => {
    const port = await allocateLoopbackPort(
      () => new FakeServer(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43_210 })),
    );
    expect(port).toBe(43_210);
  });

  it('rejects when the server cannot bind', async () => {
    await expect(
      allocateLoopbackPort(() => new FakeServer(() => null, new Error('EADDRNOTAVAIL'))),
    ).rejects.toThrow('EADDRNOTAVAIL');
  });

  it('rejects when the bound address is not a socket address', async () => {
    await expect(allocateLoopbackPort(() => new FakeServer(() => '/tmp/socket'))).rejects.toThrow(
      'could not determine the allocated port',
    );
  });
});
