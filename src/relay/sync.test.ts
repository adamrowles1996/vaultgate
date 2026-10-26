import { describe, expect, it, vi } from 'vitest';

import { fail, ok, type Result } from '../result.ts';
import {
  PEER,
  RELAY_HOST,
  relayHarness,
  type RelayHarness,
} from '../test-support/relay-fixtures.ts';
import { VaultError } from '../vault/client.ts';

import { RELAY_SYNC_INTERVAL_MS } from './sync.ts';

import type { TailnetPeer } from './whois.ts';

type SyncResult = Result<void, VaultError>;

const SYNCED: SyncResult = ok(undefined);
const UNAVAILABLE = new VaultError('vault_unavailable', 'locked');
const PROTOCOL = new VaultError('vault_protocol_error', 'odd');

async function postSync(harness: RelayHarness): Promise<{ status: number; body: unknown }> {
  const response = await harness.app.request('/sync', {
    method: 'POST',
    headers: { host: RELAY_HOST },
  });
  return { status: response.status, body: await response.json() };
}

async function syncStatus(harness: RelayHarness): Promise<number> {
  const answer = await postSync(harness);
  return answer.status;
}

/**
An operator's sync that answers each request from `results` in turn and counts them.
*/
function countingSync(...results: SyncResult[]): {
  readonly requestSync: () => Promise<SyncResult>;
  readonly count: () => number;
} {
  let calls = 0;
  return {
    requestSync: () => {
      const result = results[Math.min(calls, results.length - 1)] ?? SYNCED;
      calls += 1;
      return Promise.resolve(result);
    },
    count: () => calls,
  };
}

function lastSyncEvent(harness: RelayHarness): unknown {
  const event = harness.audit.events.at(-1);
  return { action: event?.action, outcome: event?.outcome, details: event?.details };
}

describe('relay sync', () => {
  it('RELAY-13 syncs through the operator’s sync and answers as bw serve does', async () => {
    const sync = countingSync(SYNCED);
    const harness = relayHarness({ requestSync: sync.requestSync });
    expect(await postSync(harness)).toStrictEqual({
      status: 200,
      body: {
        success: true,
        data: { object: 'message', title: 'Syncing complete.', message: null },
      },
    });
    expect(sync.count()).toBe(1);
    expect(lastSyncEvent(harness)).toStrictEqual({
      action: 'relay.sync',
      outcome: 'ok',
      details: { node: PEER.node },
    });
  });

  it('RELAY-13 shares one sync among requests within ten seconds, whichever node asks', async () => {
    const nodes = ['sandbox-1.example.ts.net', 'sandbox-2.example.ts.net'];
    let asked = 0;
    const sync = countingSync(SYNCED);
    const harness = relayHarness({
      requestSync: sync.requestSync,
      whoIs: (): Promise<TailnetPeer> => {
        asked += 1;
        return Promise.resolve({ ...PEER, node: nodes[asked % nodes.length] ?? PEER.node });
      },
    });
    await postSync(harness);
    harness.advance(RELAY_SYNC_INTERVAL_MS - 1);
    expect(await syncStatus(harness)).toBe(200);
    expect(sync.count()).toBe(1);
    expect(lastSyncEvent(harness)).toStrictEqual({
      action: 'relay.sync',
      outcome: 'ok',
      details: { node: 'sandbox-1.example.ts.net', shared: true },
    });
    harness.advance(1);
    await postSync(harness);
    expect(sync.count()).toBe(2);
    expect(harness.audit.events.at(-1)?.details).toStrictEqual({
      node: 'sandbox-2.example.ts.net',
    });
  });

  it('RELAY-13 shares a sync that is still running and answers when it finishes', async () => {
    const running = Promise.withResolvers<SyncResult>();
    let calls = 0;
    const harness = relayHarness({
      requestSync: () => {
        calls += 1;
        return running.promise;
      },
    });
    let answered = 0;
    const requests = [syncStatus(harness), syncStatus(harness)].map(async (request) => {
      const status = await request;
      answered += 1;
      return status;
    });
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    expect(answered).toBe(0);
    running.resolve(fail(UNAVAILABLE));
    expect(await Promise.all(requests)).toStrictEqual([503, 503]);
    expect(calls).toBe(1);
  });

  it('RELAY-13 answers 503 for an unavailable vault and 500 for another failure', async () => {
    const sync = countingSync(fail(UNAVAILABLE), fail(PROTOCOL));
    const harness = relayHarness({ requestSync: sync.requestSync });
    expect(await postSync(harness)).toStrictEqual({
      status: 503,
      body: { success: false, message: 'Vault is unavailable.' },
    });
    expect(harness.audit.events.at(-1)?.outcome).toBe('error:vault_unavailable');
    harness.advance(RELAY_SYNC_INTERVAL_MS);
    expect(await postSync(harness)).toStrictEqual({
      status: 500,
      body: { success: false, message: 'Vault error.' },
    });
    expect(harness.audit.events.at(-1)?.outcome).toBe('error:vault_protocol_error');
  });

  it('RELAY-13 asks the in-memory vault by default', async () => {
    const harness = relayHarness();
    expect(await syncStatus(harness)).toBe(200);
    harness.vault.failWith(UNAVAILABLE);
    harness.advance(RELAY_SYNC_INTERVAL_MS);
    expect(await syncStatus(harness)).toBe(503);
  });
});
