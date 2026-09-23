import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF } from '../test-support/actions-config.ts';
import { InMemoryTokenVerifier } from '../test-support/in-memory-token-verifier.ts';
import { FakeClock, TEST_METADATA_URL, TEST_RESOURCE } from '../test-support/test-app.ts';

import { authenticate } from './bearer.ts';
import { invalidTokenChallenge, missingTokenChallenge } from './challenges.ts';

const CONFIG = { enableWriteScope: false, actions: ACTIONS_OFF };

function verifier(): { verifier: InMemoryTokenVerifier; clock: FakeClock } {
  const clock = new FakeClock();
  return {
    verifier: new InMemoryTokenVerifier({ resource: TEST_RESOURCE, now: () => clock.now() }),
    clock,
  };
}

async function challengeOf(
  headers: Record<string, string>,
  subject: InMemoryTokenVerifier,
): Promise<{ status: number; challenge: string | null }> {
  const outcome = await authenticate(new Headers(headers), subject, CONFIG, TEST_METADATA_URL);
  const response = outcome as Response;
  return { status: response.status, challenge: response.headers.get('www-authenticate') };
}

describe('authenticate', () => {
  it('§2.3.1 answers a missing Authorization header with the first-contact challenge', async () => {
    const { verifier: subject } = verifier();
    expect(await challengeOf({}, subject)).toStrictEqual({
      status: 401,
      challenge: missingTokenChallenge(TEST_METADATA_URL),
    });
  });

  it('OAUTH-31 answers a non-Bearer Authorization header with invalid_token', async () => {
    const { verifier: subject } = verifier();
    expect(await challengeOf({ authorization: 'Basic not-a-bearer' }, subject)).toStrictEqual({
      status: 401,
      challenge: invalidTokenChallenge(TEST_METADATA_URL),
    });
    const bare = await challengeOf({ authorization: 'Bearer' }, subject);
    expect(bare.status).toBe(401);
  });

  it('OAUTH-32 answers a malformed, unknown, revoked, expired or foreign token with invalid_token', async () => {
    const { verifier: subject, clock } = verifier();
    const revoked = subject.issue({ scopes: ['vault:read'] });
    subject.revoke(revoked);
    const expired = subject.issue({ scopes: ['vault:read'], expiresAt: clock.now() + 1 });
    const foreign = subject.issue({
      scopes: ['vault:read'],
      resource: 'https://other.example/mcp',
    });
    clock.advance(1);
    const tokens = ['not-a-token', 'vg_at_unknown', revoked, expired, foreign];
    const outcomes = await Promise.all(
      tokens.map((token) => challengeOf({ authorization: `bearer ${token}` }, subject)),
    );
    expect(outcomes).toStrictEqual(
      tokens.map(() => ({ status: 401, challenge: invalidTokenChallenge(TEST_METADATA_URL) })),
    );
  });

  it('OAUTH-16 returns the verified token with scopes narrowed to the enabled set', async () => {
    const { verifier: subject } = verifier();
    const token = subject.issue({ scopes: ['vault:write', 'vault:read'] });
    const outcome = await authenticate(
      new Headers({ authorization: `Bearer ${token}` }),
      subject,
      CONFIG,
      TEST_METADATA_URL,
    );
    expect(outcome).toMatchObject({
      scopes: ['vault:read'],
      token: { clientName: 'Example Agent' },
    });
  });
});
