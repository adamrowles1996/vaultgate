import { PassThrough, Readable, type Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { captureLogger } from '../test-support/logging.ts';
import {
  LISTEN,
  PEER_ADDRESS,
  RecordingSink,
  RELAY_HOST,
  RELAY_ID,
  relayVault,
  SCOPED_COLLECTION,
} from '../test-support/relay-fixtures.ts';

import { createRelay } from './index.ts';

import type { RelayConfig } from '../config/relay.ts';
import type { LocalMessage, LocalRequestFunction } from '../net/local-http.ts';
import type { RequestOptions } from 'node:http';

const CONFIG: RelayConfig = {
  listen: LISTEN,
  tags: ['tag:sandbox'],
  collections: [SCOPED_COLLECTION],
  items: [],
  tailscaleSocket: '/nonexistent/vaultgate-test/tailscaled.sock',
};

/**
A LocalAPI that names every caller a tagged sandbox node, recording what it was asked.
*/
function fakeLocalApi(asked: RequestOptions[]): LocalRequestFunction {
  return (options, callback): Writable => {
    asked.push(options);
    const outgoing = new PassThrough();
    outgoing.on('finish', () => {
      const body = Buffer.from(
        JSON.stringify({
          Node: {
            Name: 'sandbox-1.example.ts.net.',
            Tags: ['tag:sandbox'],
            Addresses: [`${PEER_ADDRESS}/32`],
            AllowedIPs: [`${PEER_ADDRESS}/32`],
          },
        }),
      );
      const message: LocalMessage = Object.assign(Readable.from([body]), { statusCode: 200 });
      callback(message);
    });
    return outgoing;
  };
}

function relay(request?: LocalRequestFunction): ReturnType<typeof createRelay> {
  return createRelay({
    config: CONFIG,
    listen: LISTEN,
    vault: relayVault(),
    audit: new RecordingSink(),
    logger: captureLogger().logger,
    now: () => 0,
    peerAddress: () => PEER_ADDRESS,
    ...(request !== undefined && { request }),
  });
}

describe('createRelay', () => {
  it('RELAY-3 asks the configured LocalAPI socket who the caller is', async () => {
    const asked: RequestOptions[] = [];
    const app = relay(fakeLocalApi(asked));
    const response = await app.request(`/object/username/${RELAY_ID.database}`, {
      headers: { host: RELAY_HOST },
    });
    expect(await response.json()).toStrictEqual({
      success: true,
      data: { object: 'string', data: 'report_reader' },
    });
    expect(asked[0]?.socketPath).toBe(CONFIG.tailscaleSocket);
    expect(asked[0]?.path).toBe(`/localapi/v0/whois?addr=${PEER_ADDRESS}`);
  });

  it('RELAY-3 refuses every caller when the LocalAPI socket cannot be reached', async () => {
    const response = await relay().request('/status', { headers: { host: RELAY_HOST } });
    expect(response.status).toBe(403);
  });
});
