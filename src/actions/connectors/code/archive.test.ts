import { describe, expect, it } from 'vitest';

import {
  API_ADDRESS,
  ARCHIVE,
  ARCHIVE_ADDRESS,
  fakeRepo,
  recordedAccess,
  REPO,
  SHA,
} from '../../../test-support/code-connector.ts';
import {
  createFakeGitHub,
  FAKE_ARCHIVE_TOKEN,
  type FakeGitHubOptions,
} from '../../../test-support/fake-github.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import { archiveRedirectProblem, openArchive } from './archive.ts';

function github(options: Partial<FakeGitHubOptions> = {}) {
  return createFakeGitHub({ repos: [fakeRepo()], token: CANARY.password, ...options });
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

async function openOver(fake: ReturnType<typeof github>, commit: string = SHA.main) {
  return openArchive(recordedAccess(fake.fetch).access, REPO, commit);
}

const CODELOAD = `https://codeload.github.com/${REPO}/legacy.tar.gz/${SHA.main}?token=${FAKE_ARCHIVE_TOKEN}`;

describe('the archive download (ACT-104, ACT-105)', () => {
  it('ACT-117 ACT-104 asks the API for the tarball of the SHA with the token, then follows one redirect to codeload without it', async () => {
    const fake = github();
    const { access } = recordedAccess(fake.fetch);
    const stream = unwrapOk(await openArchive(access, REPO, SHA.main));
    expect(await bytesOf(stream)).toStrictEqual(ARCHIVE);
    expect(fake.requests).toStrictEqual([
      {
        url: `https://api.github.com/repos/acme/widgets/tarball/${SHA.main}`,
        address: API_ADDRESS,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'vaultgate/9.9.9',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${CANARY.password}`,
        },
      },
      { url: CODELOAD, address: ARCHIVE_ADDRESS, headers: { 'user-agent': 'vaultgate/9.9.9' } },
    ]);
  });

  it('ACT-50 ACT-104 captures the redirect URL and its token for the scrub table before following it', async () => {
    const fake = github();
    const recorded = recordedAccess(fake.fetch);
    unwrapOk(await openArchive(recorded.access, REPO, SHA.main));
    expect(recorded.captured).toStrictEqual([
      { field: 'archive_url', value: CODELOAD },
      { field: 'archive_token', value: FAKE_ARCHIVE_TOKEN },
    ]);
  });

  it('ACT-104 captures nothing of an empty query value and follows the redirect all the same', async () => {
    const fake = github({
      redirectTo: (repo, sha) => `https://codeload.github.com/${repo.fullName}/x/${sha}?t=`,
    });
    const recorded = recordedAccess(fake.fetch);
    unwrapOk(await openArchive(recorded.access, REPO, SHA.main));
    expect(recorded.captured.map((entry) => entry.field)).toStrictEqual(['archive_url']);
  });

  it('ACT-104 serves an archive the API answers directly, without a redirect', async () => {
    const fake = github({ answer: () => new Response(ARCHIVE, { status: 200 }) });
    const recorded = recordedAccess(fake.fetch);
    const stream = unwrapOk(await openArchive(recorded.access, REPO, SHA.main));
    expect(await bytesOf(stream)).toStrictEqual(ARCHIVE);
    expect(recorded.captured).toStrictEqual([]);
  });

  it('ACT-117 ACT-104 refuses a redirect anywhere but codeload under the same repository, and asks nothing more', async () => {
    const elsewhere = [
      ['http://codeload.github.com/acme/widgets/x', 'the redirect leaves the archive host'],
      ['https://evil.example/acme/widgets/x', 'the redirect leaves the archive host'],
      ['https://codeload.github.com:8443/acme/widgets/x', 'the redirect leaves the archive host'],
      [
        'https://user:pass@codeload.github.com/acme/widgets/x',
        'the redirect leaves the archive host',
      ],
      ['https://codeload.github.com/acme/gadgets/x', 'the redirect leaves the repository'],
      ['https://codeload.github.com/acme/widgets-evil/x', 'the redirect leaves the repository'],
      [
        'https://codeload.github.com/acme/widgets/../gadgets/x',
        'the redirect leaves the repository',
      ],
      ['/acme/widgets/x', 'the redirect is not a URL'],
      ['', 'the redirect is not a URL'],
    ];
    const found = [];
    for (const [location] of elsewhere) {
      const fake = github({ redirectTo: () => location ?? '' });
      const recorded = recordedAccess(fake.fetch);
      const error = unwrapFail(await openArchive(recorded.access, REPO, SHA.main));
      found.push([location, error.code, error.detail?.['message']]);
      expect([fake.requests.length, recorded.captured]).toStrictEqual([1, []]);
    }
    expect(found).toStrictEqual(
      elsewhere.map(([location, message]) => [location, 'upstream_error', message]),
    );
  });

  it('ACT-104 a redirect without a Location is refused, and nothing is followed', async () => {
    const fake = github({
      answer: (url) =>
        url.hostname === 'api.github.com' ? new Response(null, { status: 302 }) : undefined,
    });
    const error = unwrapFail(await openOver(fake));
    expect([error.code, error.detail, fake.requests.length]).toStrictEqual([
      'upstream_error',
      { message: 'the redirect is not a URL' },
      1,
    ]);
  });

  it('ACT-104 compares the repository prefix case-insensitively, as GitHub redirects to the canonical name', () => {
    expect(
      archiveRedirectProblem('https://codeload.github.com/ACME/Widgets/legacy.tar.gz/x', REPO),
    ).toBeUndefined();
    expect(
      archiveRedirectProblem('https://CODELOAD.github.com:443/acme/widgets/x', 'Acme/Widgets'),
    ).toBeUndefined();
    expect(archiveRedirectProblem('https://codeload.github.com/acme/widgets', REPO)).toBe(
      'the redirect leaves the repository',
    );
  });

  it('ACT-104 refuses a second redirect, from codeload', async () => {
    const fake = github({
      answer: (url) =>
        url.hostname === 'codeload.github.com'
          ? new Response(null, { status: 302, headers: { location: CODELOAD } })
          : undefined,
    });
    const error = unwrapFail(await openOver(fake));
    expect([error.code, error.detail]).toStrictEqual([
      'upstream_error',
      { message: 'a second redirect was refused' },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it('ACT-104 a commit the API or codeload does not have is ref_not_found; 401 authentication_failed; others upstream_error', async () => {
    const missing = unwrapFail(await openOver(github(), 'f'.repeat(40)));
    const outcomes = [missing.code];
    for (const status of [404, 401, 500]) {
      const fake = github({
        answer: (url) =>
          url.hostname === 'codeload.github.com' ? new Response('no', { status }) : undefined,
      });
      outcomes.push(unwrapFail(await openOver(fake)).code);
    }
    const apiRefused = github({ answer: () => new Response('no', { status: 403 }) });
    const refused = unwrapFail(await openOver(apiRefused));
    expect([...outcomes, refused.code]).toStrictEqual([
      'ref_not_found',
      'ref_not_found',
      'authentication_failed',
      'upstream_error',
      'upstream_error',
    ]);
  });

  it('ACT-104 an archive answer without a body is upstream_error', async () => {
    const fake = github({
      answer: (url) =>
        url.hostname === 'codeload.github.com' ? new Response(null, { status: 200 }) : undefined,
    });
    expect(unwrapFail(await openOver(fake)).detail).toStrictEqual({
      status: 200,
      message: 'GitHub answered 200',
    });
  });

  it('ACT-59 ACT-104 a transport failure on either request is its code, and an abort is timeout', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const onApi = github({ answer: () => reset });
    const onArchive = github({
      answer: (url) => (url.hostname === 'codeload.github.com' ? reset : undefined),
    });
    const first = unwrapFail(await openOver(onApi));
    const second = unwrapFail(await openOver(onArchive));
    const hung = recordedAccess(github({ answer: () => 'hang' }).fetch);
    const pending = openArchive(hung.access, REPO, SHA.main);
    hung.controller.abort();
    expect([first.code, second.code, unwrapFail(await pending).code]).toStrictEqual([
      'connection_failed',
      'connection_failed',
      'timeout',
    ]);
  });
});
