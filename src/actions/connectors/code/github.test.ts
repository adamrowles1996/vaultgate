import { describe, expect, it } from 'vitest';

import {
  API_ADDRESS,
  fakeRepo,
  recordedAccess,
  REPO,
  SHA,
} from '../../../test-support/code-connector.ts';
import { createFakeGitHub, type FakeGitHubOptions } from '../../../test-support/fake-github.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import { resolveReference } from './github.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';

function github(options: Partial<FakeGitHubOptions> = {}) {
  return createFakeGitHub({ repos: [fakeRepo()], token: CANARY.password, ...options });
}

async function resolveOver(fake: { readonly fetch: PinnedFetch }, text: string | undefined) {
  return resolveReference(recordedAccess(fake.fetch).access, REPO, text);
}

/**
A careless library rejects with text rather than an Error.
*/
const thrower: PinnedFetch = () =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
  Promise.reject('connect ECONNREFUSED 140.82.121.6:443');

function pathsOf(fake: ReturnType<typeof github>): readonly string[] {
  return fake.requests.map((request) => new URL(request.url).pathname);
}

describe('resolving a ref (ACT-104)', () => {
  it('ACT-104 resolves the default branch through /repos, then as a branch with the sha media type', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapOk(await resolveReference(access, REPO, undefined))).toStrictEqual({
      commit: SHA.main,
      ref: 'main',
    });
    expect(fake.requests.map((request) => [request.url, request.headers['accept']])).toStrictEqual([
      ['https://api.github.com/repos/acme/widgets', 'application/vnd.github+json'],
      ['https://api.github.com/repos/acme/widgets/commits/main', 'application/vnd.github.sha'],
    ]);
  });

  it('ACT-104 resolves a branch or tag with one request whose body is the SHA', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapOk(await resolveReference(access, REPO, 'v1.0'))).toStrictEqual({
      commit: SHA.tag,
      ref: 'v1.0',
    });
    expect(unwrapOk(await resolveReference(access, REPO, 'feature/x'))).toStrictEqual({
      commit: SHA.moved,
      ref: 'feature/x',
    });
    expect(pathsOf(fake)).toStrictEqual([
      '/repos/acme/widgets/commits/v1.0',
      '/repos/acme/widgets/commits/feature/x',
    ]);
  });

  it('ACT-104 uses a 40-hex SHA as it is, without asking GitHub', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapOk(await resolveReference(access, REPO, SHA.other))).toStrictEqual({
      commit: SHA.other,
      ref: SHA.other,
    });
    expect(fake.requests).toStrictEqual([]);
  });

  it('ACT-104 resolves pr:<n> through refs/pull/<n>/head of the base repository with the sha media type', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapOk(await resolveReference(access, REPO, 'pr:7'))).toStrictEqual({
      commit: SHA.pull,
      ref: 'pr:7',
    });
    expect(fake.requests.map((request) => [request.url, request.headers['accept']])).toStrictEqual([
      [
        'https://api.github.com/repos/acme/widgets/commits/refs/pull/7/head',
        'application/vnd.github.sha',
      ],
    ]);
    expect(pathsOf(fake).some((path) => path.includes('/pulls/'))).toBe(false);
  });

  it('ACT-103 sends the token as a bearer to api.github.com, at the pinned address, with the API version', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    await resolveReference(access, REPO, 'main');
    expect(fake.requests).toStrictEqual([
      {
        url: 'https://api.github.com/repos/acme/widgets/commits/main',
        address: API_ADDRESS,
        headers: {
          accept: 'application/vnd.github.sha',
          'user-agent': 'vaultgate/9.9.9',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${CANARY.password}`,
        },
      },
    ]);
  });

  it('ACT-103 sends no Authorization at all without a token, and a public repository still resolves', async () => {
    const fake = github({ repos: [fakeRepo({ isPrivate: false })] });
    const { access } = recordedAccess(fake.fetch, { token: undefined });
    expect(unwrapOk(await resolveReference(access, REPO, undefined)).commit).toBe(SHA.main);
    expect(
      fake.requests.map((request) =>
        Object.keys(request.headers).toSorted((left, right) => left.localeCompare(right)),
      ),
    ).toStrictEqual([
      ['accept', 'user-agent', 'x-github-api-version'],
      ['accept', 'user-agent', 'x-github-api-version'],
    ]);
  });

  it('ACT-104 percent-encodes a default branch name from GitHub into the path, and keeps it scrubbed for later', async () => {
    const fake = github({
      repos: [fakeRepo({ defaultBranch: 'weird #branch?', refs: { 'weird #branch?': SHA.tag } })],
    });
    const { access } = recordedAccess(fake.fetch, {
      scrub: (text) => text.replace('weird', '[x]'),
    });
    expect(unwrapOk(await resolveReference(access, REPO, undefined))).toStrictEqual({
      commit: SHA.tag,
      ref: '[x] #branch?',
    });
    expect(fake.requests[1]?.url).toBe(
      'https://api.github.com/repos/acme/widgets/commits/weird%20%23branch%3F',
    );
  });

  it('ACT-104 never puts a ref that follows no rule into a GitHub path', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    for (const text of ['a/../b', '/main', 'main/', 'pr:0', 'x y']) {
      const error = unwrapFail(await resolveReference(access, REPO, text));
      expect([error.code, error.detail]).toStrictEqual([
        'invalid_arguments',
        { problem: 'ref: follows no rule of ACT-104' },
      ]);
    }
    expect(fake.requests).toStrictEqual([]);
  });
});

describe('resolution failures (ACT-104)', () => {
  it('ACT-104 a 404 or 422 at any step is ref_not_found', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapFail(await resolveReference(access, 'acme/nothing', undefined)).code).toBe(
      'ref_not_found',
    );
    expect(unwrapFail(await resolveReference(access, REPO, 'no-such-branch')).code).toBe(
      'ref_not_found',
    );
    expect(unwrapFail(await resolveReference(access, REPO, 'pr:8')).code).toBe('ref_not_found');
    const wrongToken = recordedAccess(fake.fetch, { token: 'someone-else' }).access;
    expect(unwrapFail(await resolveReference(wrongToken, REPO, 'main')).code).toBe('ref_not_found');
  });

  it('ACT-104 a 401 is authentication_failed; any other status is upstream_error with the status only', async () => {
    const statuses = [401, 403, 500, 301];
    const codes = [];
    for (const status of statuses) {
      const fake = github({
        answer: () => Response.json({ message: CANARY.password }, { status }),
      });
      const error = unwrapFail(await resolveOver(fake, 'main'));
      codes.push([error.code, error.detail]);
    }
    expect(codes).toStrictEqual([
      ['authentication_failed', undefined],
      ['upstream_error', { status: 403, message: 'GitHub answered 403' }],
      ['upstream_error', { status: 500, message: 'GitHub answered 500' }],
      ['upstream_error', { status: 301, message: 'GitHub answered 301' }],
    ]);
  });

  it('ACT-104 a body that is not what the step expects is upstream_error', async () => {
    const OUT_OF_SHAPE = ['upstream_error', { message: 'GitHub answered out of shape' }];
    const bodies: [string | undefined, Response][] = [
      ['main', new Response('not a sha', { status: 200 })],
      ['main', new Response(SHA.main.toUpperCase(), { status: 200 })],
      ['main', new Response(null, { status: 200 })],
      ['main', new Response('a'.repeat(8 * 1024 * 1024 + 1), { status: 200 })],
      [undefined, new Response('{not json', { status: 200 })],
      [undefined, Response.json({ full_name: REPO }, { status: 200 })],
      [undefined, Response.json({ full_name: REPO, default_branch: '' }, { status: 200 })],
    ];
    const found = [];
    for (const [reference, response] of bodies) {
      const fake = github({ answer: () => response });
      const error = unwrapFail(await resolveOver(fake, reference));
      found.push([error.code, error.detail]);
    }
    expect(found).toStrictEqual(bodies.map(() => OUT_OF_SHAPE));
  });

  it('ACT-104 accepts a SHA body with the trailing newline GitHub sends', async () => {
    const fake = github({ answer: () => new Response(`${SHA.tag}\n`, { status: 200 }) });
    expect(unwrapOk(await resolveOver(fake, 'v1.0')).commit).toBe(SHA.tag);
  });

  it('ACT-57 ACT-59 a transport failure is timeout when aborted, tls_error for a certificate, connection_failed otherwise', async () => {
    const outcomes = [];
    const errors: unknown[] = [
      Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
      Object.assign(new Error('bad record'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      new TypeError('fetch failed'),
    ];
    for (const error of errors) {
      const fake = github({ answer: () => error as Error });
      const failure = unwrapFail(await resolveOver(fake, 'main'));
      outcomes.push([failure.code, failure.detail]);
    }
    const hung = recordedAccess(github({ answer: () => 'hang' }).fetch);
    const pending = resolveReference(hung.access, REPO, 'main');
    hung.controller.abort();
    const aborted = unwrapFail(await pending);
    expect([...outcomes, [aborted.code, aborted.detail]]).toStrictEqual([
      ['tls_error', { reason: 'CERT_HAS_EXPIRED' }],
      ['tls_error', { reason: 'ERR_SSL_WRONG_VERSION_NUMBER' }],
      ['connection_failed', { reason: 'ECONNRESET' }],
      ['connection_failed', { reason: 'TypeError' }],
      ['timeout', undefined],
    ]);
  });

  it('ACT-74 a transport failure that is not an Error still names no address', async () => {
    const failure = unwrapFail(await resolveOver({ fetch: thrower }, 'main'));
    expect([failure.code, failure.detail]).toStrictEqual([
      'connection_failed',
      { reason: 'unknown' },
    ]);
  });
});
