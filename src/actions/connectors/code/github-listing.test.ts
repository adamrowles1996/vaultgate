import { describe, expect, it } from 'vitest';

import { fakeRepo, recordedAccess, REPO } from '../../../test-support/code-connector.ts';
import {
  createFakeGitHub,
  type FakeGitHub,
  type FakeRepo,
} from '../../../test-support/fake-github.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import { listRepos, repoInfo } from './github.ts';

async function listOver(fake: FakeGitHub, token?: string) {
  const { access } = recordedAccess(fake.fetch, token === undefined ? {} : { token });
  return listRepos(access);
}

function repos(count: number): FakeRepo[] {
  return Array.from({ length: count }, (_value, index) =>
    fakeRepo({
      fullName: `acme/repo-${String(index).padStart(4, '0')}`,
      isPrivate: index % 2 === 0,
    }),
  );
}

describe('the repository as the token sees it (ACT-120)', () => {
  it('ACT-120 answers the full name, the default branch and the visibility', async () => {
    const fake = createFakeGitHub({ repos: [fakeRepo()], token: CANARY.password });
    const { access } = recordedAccess(fake.fetch);
    expect(unwrapOk(await repoInfo(access, REPO))).toStrictEqual({
      fullName: REPO,
      defaultBranch: 'main',
      visibility: 'private',
    });
    expect(fake.requests.map((request) => request.url)).toStrictEqual([
      'https://api.github.com/repos/acme/widgets',
    ]);
  });

  it('ACT-120 reads the visibility from `private` when GitHub leaves `visibility` out', async () => {
    const answers = [
      { full_name: REPO, default_branch: 'main', private: true },
      { full_name: REPO, default_branch: 'main', private: false },
      { full_name: REPO, default_branch: 'main' },
    ];
    const found = [];
    for (const body of answers) {
      const fake = createFakeGitHub({ repos: [], answer: () => Response.json(body) });
      const { access } = recordedAccess(fake.fetch);
      found.push(unwrapOk(await repoInfo(access, REPO)).visibility);
    }
    expect(found).toStrictEqual(['private', 'public', 'public']);
  });

  it('ACT-120 a repository the token cannot read is upstream_error 404 with a fixed message', async () => {
    const fake = createFakeGitHub({ repos: [fakeRepo()], token: CANARY.password });
    const { access } = recordedAccess(fake.fetch, { token: 'another-token' });
    const error = unwrapFail(await repoInfo(access, REPO));
    expect([error.code, error.detail]).toStrictEqual([
      'upstream_error',
      { status: 404, message: 'the repository was not found, or the token cannot read it' },
    ]);
  });
});

describe('the repositories a token can read (ACT-119)', () => {
  it('ACT-119 lists 100 a page, sorted by name, and stops at the first short page', async () => {
    const fake = createFakeGitHub({ repos: repos(150), token: CANARY.password });
    const listed = unwrapOk(await listOver(fake));
    expect(listed).toHaveLength(150);
    expect(listed[0]).toStrictEqual({ fullName: 'acme/repo-0000', isPrivate: true });
    expect(listed[1]).toStrictEqual({ fullName: 'acme/repo-0001', isPrivate: false });
    expect(fake.requests.map((request) => new URL(request.url).search)).toStrictEqual([
      '?per_page=100&page=1&sort=full_name',
      '?per_page=100&page=2&sort=full_name',
    ]);
  });

  it('ACT-119 reads at most 10 pages', async () => {
    const fake = createFakeGitHub({ repos: repos(1050), token: CANARY.password });
    expect(unwrapOk(await listOver(fake))).toHaveLength(1000);
    expect(fake.requests).toHaveLength(10);
  });

  it('ACT-119 asks for the page after a full one, which may be empty', async () => {
    const fake = createFakeGitHub({ repos: repos(100), token: CANARY.password });
    expect(unwrapOk(await listOver(fake))).toHaveLength(100);
    expect(fake.requests).toHaveLength(2);
  });

  it('ACT-119 a token GitHub refuses is authentication_failed and an odd answer upstream_error', async () => {
    const fake = createFakeGitHub({ repos: repos(3), token: CANARY.password });
    const refused = unwrapFail(
      await listRepos(recordedAccess(fake.fetch, { token: undefined }).access),
    );
    expect(refused.code).toBe('authentication_failed');
    const odd = createFakeGitHub({ repos: [], answer: () => Response.json({ items: [] }) });
    const error = unwrapFail(await listOver(odd));
    expect([error.code, error.detail]).toStrictEqual([
      'upstream_error',
      { message: 'GitHub answered out of shape' },
    ]);
    const missing = createFakeGitHub({
      repos: [],
      answer: () => new Response(null, { status: 404 }),
    });
    expect(unwrapFail(await listOver(missing)).detail).toStrictEqual({
      status: 404,
      message: 'GitHub has no such listing',
    });
  });
});
