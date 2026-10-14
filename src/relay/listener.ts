/**
 * The relay's own listener (RELAY-2). It binds one tailnet address, which
 * exists only once the Tailscale daemon has brought its interface up, so a
 * failed bind is retried instead of ending the process: vaultgate's main
 * listener and the actions layer must not depend on the relay's network.
 */
import type { RelayListen } from '../config/relay.ts';
import type { Logger } from '../logger.ts';

/**
The part of `http.Server` the listener drives.
*/
export interface ListeningServer {
  listen(port: number, host: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'listening', listener: () => void): unknown;
  close(): unknown;
}

export interface RelayListenerOptions {
  readonly server: ListeningServer;
  readonly listen: RelayListen;
  readonly logger: Logger;
  /**
  How long to wait before binding again after a failure.
  */
  readonly retryMs: number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface RelayListener {
  close(): void;
}

export function startRelayListener(options: RelayListenerOptions): RelayListener {
  const { server, listen, logger } = options;
  let cancelRetry: (() => void) | undefined;
  let isClosed = false;
  const bind = (): void => {
    cancelRetry = undefined;
    server.listen(listen.port, listen.host);
  };
  server.on('listening', () => {
    logger.info({ host: listen.host, port: listen.port }, 'credential relay listening');
  });
  server.on('error', (error) => {
    logger.warn(
      { err: error, host: listen.host, port: listen.port, retryMs: options.retryMs },
      'credential relay could not listen; retrying',
    );
    if (!isClosed) {
      cancelRetry = options.schedule(bind, options.retryMs);
    }
  });
  bind();
  return {
    close() {
      isClosed = true;
      cancelRetry?.();
      server.close();
    },
  };
}
