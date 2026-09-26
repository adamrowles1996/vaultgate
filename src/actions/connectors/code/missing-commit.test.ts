import { describe, expect, it } from 'vitest';

import {
  codeCaller,
  createCodeHarness,
  createCodeTarget,
  fakeRepo,
  recordedAccess,
  REPO,
  search,
  SHA,
  sidecarResult,
} from '../../../test-support/code-connector.ts';
import { createFakeGitHub } from '../../../test-support/fake-github.ts';
import { unwrapFail } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import { openArchive } from './archive.ts';
import { codeCredentialSchema, codeDestinationSchema, codePolicySchema } from './schemas.ts';
import { createCodeState } from './state.ts';

import type { BuildRequest } from './builds.ts';

const NOWHERE = 'f'.repeat(40);

function tarballs(code: ReturnType<typeof createCodeHarness>): number {
  return code.github.requests.filter((request) => request.url.includes('/tarball/')).length;
}

function failures(code: ReturnType<typeof createCodeHarness>): readonly unknown[] {
  return code.harness.audit
    .filter((event) => event.action === 'code_index_failed')
    .map((event) => [event.outcome, event.details?.['commit'], event.details?.['trigger']]);
}

function failedRequest(commit: string): BuildRequest {
  return {
    targetId: 'id-1',
    targetName: 'widgets',
    documents: {
      destination: codeDestinationSchema.parse({ repository: REPO }),
      credential: codeCredentialSchema.parse({}),
      policy: codePolicySchema.parse({ refresh_interval_s: 60 }),
    },
    commit,
    ref: commit,
    trigger: 'call',
    variants: [['code']],
    configured: false,
  };
}

describe('a commit GitHub has no archive of (ACT-104, ACT-112)', () => {
  it('ACT-104 the API’s 422 for a tarball is ref_not_found too', async () => {
    const fake = createFakeGitHub({
      repos: [fakeRepo()],
      token: CANARY.password,
      answer: (url) =>
        url.pathname.includes('/tarball/') ? new Response('no', { status: 422 }) : undefined,
    });
    const refused = unwrapFail(await openArchive(recordedAccess(fake.fetch).access, REPO, NOWHERE));
    expect(refused.code).toBe('ref_not_found');
  });

  it('ACT-104 ACT-112 a SHA a call names that GitHub has no archive of answers ref_not_found, and a retry within refresh_interval_s fetches nothing', async () => {
    const code = createCodeHarness({ sidecar: { answer: () => [sidecarResult('widgets')] } });
    await createCodeTarget(code, { policy: { refresh_interval_s: 60 } });
    const before = tarballs(code);
    const first = await code.harness.engine.call(codeCaller(), search('widgets', { ref: NOWHERE }));
    expect(first.kind === 'error' && [first.error.code, first.error.detail]).toStrictEqual([
      'ref_not_found',
      undefined,
    ]);
    expect([tarballs(code) - before, failures(code)]).toStrictEqual([
      1,
      [['error:ref_not_found', NOWHERE, 'call']],
    ]);
    const again = await code.harness.engine.call(codeCaller(), search('widgets', { ref: NOWHERE }));
    expect(again.kind === 'error' && again.error.code).toBe('ref_not_found');
    expect([tarballs(code) - before, failures(code).length]).toStrictEqual([1, 1]);
    await code.harness.clock.advance(60_000);
    await code.harness.engine.call(codeCaller(), search('widgets', { ref: NOWHERE }));
    expect([tarballs(code) - before, failures(code).length]).toStrictEqual([2, 2]);
    // The configured ref is untouched by it.
    const configured = await code.harness.engine.call(codeCaller(), search('widgets'));
    expect(configured.kind).toBe('ok');
  });

  it('ACT-112 a failure older than refresh_interval_s goes when another is remembered', () => {
    let now = 0;
    const state = createCodeState({
      services: {
        audit: {
          record: () => {
            // Not under test here.
          },
        },
        now: () => now,
      },
      fingerprintOf: () => '0123456789abcdef',
      keyOf: (request) => `id-1.0123456789abcdef.${request.commit}`,
    });
    const ended = { durationMs: 1, isAbandoned: false };
    state.finished(failedRequest(SHA.tag), { ok: false, reason: 'ref_not_found' }, ended);
    now = 30_000;
    state.finished(failedRequest(SHA.pull), { ok: false, reason: 'build_failed' }, ended);
    const { failed } = state.target('id-1');
    expect(failed.size).toBe(2);
    now = 60_000;
    state.finished(failedRequest(SHA.moved), { ok: false, reason: 'ref_not_found' }, ended);
    expect(failed.size).toBe(2);
    expect(failed.has(`id-1.0123456789abcdef.${SHA.tag}`)).toBe(false);
    expect(failed.get(`id-1.0123456789abcdef.${SHA.pull}`)).toStrictEqual({
      reason: 'build_failed',
      at: 30_000,
    });
  });
});
