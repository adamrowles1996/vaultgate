import { describe, expect, it } from 'vitest';

import { captureLogger } from '../../../test-support/logging.ts';
import { ManualClock } from '../../../test-support/manual-clock.ts';
import { recordedSupport } from '../../../test-support/run-support.ts';

import { createBuilds, githubAccess, type BuildRequest } from './builds.ts';
import { codeCredentialSchema, codeDestinationSchema, codePolicySchema } from './schemas.ts';
import { background } from './timing.ts';

import type { ConnectorServices, TargetAccess } from '../connector.ts';
import type { SidecarClient } from './sidecar.ts';

function access(pinned: TargetAccess['pinned']): TargetAccess {
  const policy = codePolicySchema.parse({});
  const { logger } = captureLogger();
  return {
    destination: codeDestinationSchema.parse({ repository: 'acme/widgets' }),
    credential: codeCredentialSchema.parse({ token_field: null }),
    policy,
    common: policy,
    injected: recordedSupport().secrets.injected,
    support: recordedSupport().support,
    pinned,
    logger,
  };
}

function services(clock: ManualClock): ConnectorServices {
  const { logger } = captureLogger();
  const events: unknown[] = [];
  return {
    logger,
    now: () => clock.now(),
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    audit: {
      record: (event) => {
        events.push(event);
      },
    },
    withTarget: () => Promise.reject(new Error('not in this test')),
    targets: () => [],
  };
}

describe('the build runner (ACT-108)', () => {
  it('ACT-108 a sidecar client that throws instead of answering still ends the build, once, as a connector fault', async () => {
    const clock = new ManualClock();
    const ended: string[] = [];
    const throwing = {
      build: () => Promise.reject(new Error('a client bug')),
    } as unknown as SidecarClient;
    const builds = createBuilds({
      sidecar: throwing,
      fetch: () => Promise.resolve(new Response('archive', { status: 200 })),
      services: services(clock),
      userAgent: 'vaultgate/9.9.9',
      finished: (_request, outcome) => {
        ended.push(outcome.ok ? 'ok' : outcome.reason);
      },
    });
    const pinned = [
      { host: 'api.github.com', tls: true, address: '140.82.121.6' },
      { host: 'codeload.github.com', tls: true, address: '140.82.121.9' },
    ];
    const target = access(pinned);
    const request: BuildRequest = {
      targetId: 'id-1',
      targetName: 'widgets',
      documents: {
        destination: target.destination,
        credential: target.credential,
        policy: target.policy,
      } as BuildRequest['documents'],
      commit: 'a'.repeat(40),
      ref: 'main',
      trigger: 'save',
      variants: [['code']],
      configured: true,
    };
    expect(await builds.run(target, request)).toStrictEqual({
      ok: false,
      reason: 'connector_fault',
    });
    expect([ended, builds.isBuilding('id-1')]).toStrictEqual([['connector_fault'], false]);
  });

  it('ACT-55 an endpoint the engine did not pin gets no address, and a null token field sends no token', () => {
    const github = githubAccess(
      access([]),
      { fetch: () => Promise.reject(new Error('unused')), userAgent: 'x' },
      new AbortController().signal,
    );
    expect([github.apiAddress, github.archiveAddress, github.token]).toStrictEqual([
      '',
      '',
      undefined,
    ]);
  });
});

describe('background work (ACT-108)', () => {
  it('ACT-108 work started without waiting for it logs a failure by its name, never its message, and never rejects', async () => {
    const clock = new ManualClock();
    const { logger, lines } = captureLogger();
    background({ logger }, 'a build on save', () =>
      Promise.reject(new TypeError('secret-bearing message')),
    );
    background({ logger }, 'a deletion', () => Promise.reject(new Error('x')));
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a careless library rejects with text
    background({ logger }, 'a check', () => Promise.reject('text'));
    await clock.settle();
    expect(lines().map((line) => [line['msg'], line['error']])).toStrictEqual([
      ['code connector: a build on save failed', 'TypeError'],
      ['code connector: a deletion failed', 'Error'],
      ['code connector: a check failed', 'unknown'],
    ]);
    expect(JSON.stringify(lines())).not.toContain('secret-bearing');
  });
});
