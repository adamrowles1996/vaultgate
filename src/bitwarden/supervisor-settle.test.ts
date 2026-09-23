import { describe, expect, it } from 'vitest';

import { SupervisorHarness } from '../test-support/supervisor-harness.ts';

import { SERVE_SETTLE_MS, SERVE_SETTLE_POLL_MS } from './supervisor-support.ts';

import type { FetchFunction } from './api.ts';
import type { FakeBwServe } from '../test-support/fake-bw-serve.ts';

const SETTLING = 'bw serve is still settling; retrying unlock';
const FAILED = 'vault backend start failed';

/**
A `bw serve` whose `/unlock` answers with a Koa error page `times` times before it is ready.
*/
function unlockNotReadyFor(fake: FakeBwServe, times: number): FetchFunction {
  let remaining = times;
  return (input, init) => {
    if (new URL(input).pathname === '/unlock' && remaining > 0) {
      remaining -= 1;
      return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
    }
    return fake.fetch(input, init);
  };
}

function harnessWithUnlockNotReadyFor(times: number): SupervisorHarness {
  const probe = new SupervisorHarness();
  return new SupervisorHarness({ fake: probe.fake, fetch: unlockNotReadyFor(probe.fake, times) });
}

describe('startVaultSupervisor settle window (VAULT-6)', () => {
  it('retries an unlock that a freshly started bw serve answers without its envelope', async () => {
    const harness = harnessWithUnlockNotReadyFor(2);
    const supervisor = harness.start();
    await harness.until(() => harness.linesFor(SETTLING).length === 1);
    expect(supervisor.isReady()).toBe(false);
    await harness.clock.advance(SERVE_SETTLE_POLL_MS);
    await harness.until(() => harness.linesFor(SETTLING).length === 2);
    await harness.clock.advance(SERVE_SETTLE_POLL_MS);
    await harness.until(() => supervisor.isReady());
    expect(harness.linesFor(FAILED)).toStrictEqual([]);
    expect(harness.linesFor(SETTLING)[0]).toMatchObject({
      err: { message: 'the vault gave an unexpected response' },
    });
    expect(harness.fake.requestsTo('/unlock')).toHaveLength(1);
    expect(harness.spawner.spawned('serve')).toHaveLength(1);
    await supervisor.stop();
  });

  it('counts a protocol error as a failed start once the settle window has passed', async () => {
    const harness = harnessWithUnlockNotReadyFor(Infinity);
    const supervisor = harness.start();
    await harness.until(() => harness.linesFor(SETTLING).length === 1);
    for (
      let elapsed = 0;
      elapsed <= SERVE_SETTLE_MS && harness.linesFor(FAILED).length === 0;
      elapsed += SERVE_SETTLE_POLL_MS
    ) {
      await harness.clock.advance(SERVE_SETTLE_POLL_MS);
    }
    expect(harness.linesFor(FAILED)).toHaveLength(1);
    expect(harness.linesFor(FAILED)[0]).toMatchObject({
      err: { message: 'the vault gave an unexpected response' },
      attempt: 1,
      nextRetryMs: 1000,
    });
    expect(harness.linesFor(SETTLING)).toHaveLength(SERVE_SETTLE_MS / SERVE_SETTLE_POLL_MS);
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    expect(supervisor.isReady()).toBe(false);
    await supervisor.stop();
  });

  it('stops promptly while waiting for bw serve to settle and records nothing', async () => {
    const harness = harnessWithUnlockNotReadyFor(Infinity);
    const supervisor = harness.start();
    await harness.until(() => harness.linesFor(SETTLING).length === 1);
    expect(harness.clock.pending()).toBe(1);
    await supervisor.stop();
    expect(harness.linesFor(FAILED)).toStrictEqual([]);
    expect(harness.serveChild().signals).toStrictEqual(['SIGTERM']);
    expect(harness.clock.pending()).toBe(0);
    expect(supervisor.isReady()).toBe(false);
  });
});
