import { describe, expect, it } from 'vitest';

import { FakeBwServe } from '../test-support/fake-bw-serve.ts';
import { SupervisorHarness } from '../test-support/supervisor-harness.ts';

import { SYNC_PROTOCOL_RETRY_MS } from './supervisor-sync.ts';

import type { FetchFunction } from './api.ts';

const RETRYING = 'vault sync answered without its envelope; retrying';
const FAILED = 'vault backend start failed';

interface SyncControl {
  readonly fetch: FetchFunction;
  readonly syncsStarted: () => number;
  /**
  Lets the sync numbered `held` (if any) finish; it waits until then.
  */
  readonly release: () => void;
}

/**
A `bw serve` whose `/sync` answers without its envelope `times` times, optionally holding one sync until released.
*/
function syncControl(fake: FakeBwServe, times: number, held?: number): SyncControl {
  const gate = Promise.withResolvers<undefined>();
  let remaining = times;
  let syncs = 0;
  const fetchFunction: FetchFunction = async (input, init) => {
    if (new URL(input).pathname !== '/sync') {
      return fake.fetch(input, init);
    }
    syncs += 1;
    if (syncs === held) {
      await gate.promise;
    }
    if (remaining > 0) {
      remaining -= 1;
      return new Response('<html>Internal Server Error</html>', { status: 500 });
    }
    return fake.fetch(input, init);
  };
  return {
    fetch: fetchFunction,
    syncsStarted: () => syncs,
    release: () => {
      gate.resolve(undefined);
    },
  };
}

function harnessWith(
  times: number,
  held?: number,
): { harness: SupervisorHarness; control: SyncControl } {
  const fake = new FakeBwServe({ state: 'locked' });
  const control = syncControl(fake, times, held);
  return { harness: new SupervisorHarness({ fake, fetch: control.fetch }), control };
}

describe('startVaultSupervisor sync retry (VAULT-17)', () => {
  it('retries the initial sync once after two seconds when it answers without its envelope', async () => {
    const { harness, control } = harnessWith(1);
    const supervisor = harness.start();
    await harness.until(() => harness.linesFor(RETRYING).length === 1);
    expect(supervisor.isReady()).toBe(false);
    expect(harness.clock.pending()).toBe(1);
    await harness.clock.advance(SYNC_PROTOCOL_RETRY_MS);
    await harness.until(() => supervisor.isReady());
    expect(control.syncsStarted()).toBe(2);
    expect(harness.linesFor(RETRYING)[0]).toMatchObject({
      level: 20,
      err: { message: 'the vault gave an unexpected response' },
    });
    expect(harness.linesFor('vault synced')[0]).toMatchObject({
      kind: 'initial',
      durationMs: SYNC_PROTOCOL_RETRY_MS,
    });
    expect(harness.messages()).not.toContain('initial vault sync failed');
    expect(supervisor.syncState()).toStrictEqual({
      lastSyncAt: '2026-09-22T12:00:02.000Z',
      lastSyncError: null,
    });
    await supervisor.stop();
  });

  it('reports a scheduled sync that fails twice and stays ready', async () => {
    const { harness, control } = harnessWith(0);
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    harness.fake.override('POST', '/sync', 'not json');
    await harness.clock.advance(60_000);
    await harness.until(() => harness.linesFor(RETRYING).length === 1);
    await harness.clock.advance(SYNC_PROTOCOL_RETRY_MS);
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(control.syncsStarted()).toBe(3);
    expect(harness.linesFor(RETRYING)).toHaveLength(1);
    expect(harness.linesFor('vault sync failed')[0]).toMatchObject({
      kind: 'scheduled',
      err: { message: 'the vault gave an unexpected response' },
    });
    expect(supervisor.isReady()).toBe(true);
    expect(harness.linesFor(FAILED)).toStrictEqual([]);
    expect(supervisor.syncState()).toMatchObject({ lastSyncError: 'vault_protocol_error' });
    expect(harness.serveChild().signals).toStrictEqual([]);
    await harness.clock.advance(60_000);
    await harness.until(() => control.syncsStarted() === 4);
    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
  });

  it('abandons the retry when stopped while waiting', async () => {
    const { harness, control } = harnessWith(0);
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    harness.fake.override('POST', '/sync', 'not json');
    await harness.clock.advance(60_000);
    await harness.until(() => harness.linesFor(RETRYING).length === 1);
    await supervisor.stop();
    expect(control.syncsStarted()).toBe(2);
    expect(harness.messages()).toContain('vault sync failed');
    expect(harness.clock.pending()).toBe(0);
  });

  it('does not retry, and counts nothing twice, when bw serve exits during a sync', async () => {
    const { harness, control } = harnessWith(0, 2);
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await harness.clock.advance(60_000);
    await harness.until(() => control.syncsStarted() === 2);
    harness.serveChild(0).exit(1);
    await harness.until(() => harness.linesFor(FAILED).length === 1);
    harness.fake.override('POST', '/sync', 'not json');
    control.release();
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(control.syncsStarted()).toBe(2);
    expect(harness.linesFor(RETRYING)).toStrictEqual([]);
    expect(harness.linesFor(FAILED)).toHaveLength(1);
    expect(harness.linesFor(FAILED)[0]).toMatchObject({ attempt: 1, nextRetryMs: 1000 });
    expect(harness.clock.pending()).toBe(1);
    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
  });
});

describe('startVaultSupervisor periodic sync (VAULT-9)', () => {
  it('VAULT-9 logs a failed initial sync and stays ready', async () => {
    const harness = new SupervisorHarness();
    harness.fake.override('POST', '/sync', { success: false, message: 'Vault is locked.' });
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.linesFor('initial vault sync failed')[0]).toMatchObject({
      level: 40,
      kind: 'initial',
      err: { message: 'the vault is locked or not reachable' },
    });
    expect(harness.linesFor('vault synced')).toStrictEqual([]);
    expect(supervisor.syncState()).toStrictEqual({
      lastSyncAt: null,
      lastSyncError: 'vault_unavailable',
    });
    await supervisor.stop();
  });

  it('VAULT-9 logs the initial sync at info once it succeeds', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.linesFor('vault synced')[0]).toMatchObject({ level: 30, kind: 'initial' });
    expect(supervisor.syncState()).toStrictEqual({
      lastSyncAt: '2026-09-22T12:00:00.000Z',
      lastSyncError: null,
    });
    await supervisor.stop();
  });

  it('VAULT-9 syncs every interval and a failure does not affect readiness', async () => {
    const harness = new SupervisorHarness();
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    expect(harness.fake.requestsTo('/sync')).toHaveLength(1);

    await harness.clock.advance(60_000);
    await harness.until(() => harness.fake.requestsTo('/sync').length === 2);
    expect(harness.linesFor('vault synced')).toHaveLength(2);
    expect(harness.linesFor('vault synced')[1]).toMatchObject({
      level: 30,
      kind: 'scheduled',
      durationMs: 0,
    });
    expect(supervisor.syncState()).toStrictEqual({
      lastSyncAt: '2026-09-22T12:01:00.000Z',
      lastSyncError: null,
    });

    harness.fake.override('POST', '/sync', { success: false, message: 'Vault is locked.' });
    await harness.clock.advance(60_000);
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(supervisor.isReady()).toBe(true);
    expect(harness.linesFor('vault sync failed')[0]).toMatchObject({
      level: 40,
      kind: 'scheduled',
      err: { message: 'the vault is locked or not reachable' },
    });
    expect(supervisor.syncState()).toStrictEqual({
      lastSyncAt: '2026-09-22T12:01:00.000Z',
      lastSyncError: 'vault_unavailable',
    });

    await supervisor.stop();
    expect(harness.clock.pending()).toBe(0);
  });

  it('VAULT-9 does not reschedule a sync that finishes after shutdown', async () => {
    const { harness, control } = harnessWith(0, 2);
    const supervisor = harness.start();
    await harness.until(() => supervisor.isReady());
    await harness.clock.advance(60_000);
    await harness.until(() => control.syncsStarted() === 2);
    await supervisor.stop();
    control.release();
    await harness.until(() => harness.messages().includes('vault sync failed'));
    expect(supervisor.isReady()).toBe(false);
    expect(harness.clock.pending()).toBe(0);
  });
});
