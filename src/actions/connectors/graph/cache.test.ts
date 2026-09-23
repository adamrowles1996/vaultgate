import { describe, expect, it } from 'vitest';

import { createTokenCache, TOKEN_MARGIN_MS } from './cache.ts';

const HOUR_MS = 3_600_000;

describe('the graph access-token cache', () => {
  it('ACT-82 answers with the token while it lives and gives it up 60 s before it expires', () => {
    const cache = createTokenCache();
    cache.set('target-1', { revision: 3, token: 'first', expiresAt: HOUR_MS });
    expect(cache.get('target-1', 3, 0)).toBe('first');
    expect(cache.get('target-1', 3, HOUR_MS - TOKEN_MARGIN_MS - 1)).toBe('first');
    cache.set('target-1', { revision: 3, token: 'first', expiresAt: HOUR_MS });
    expect(cache.get('target-1', 3, HOUR_MS - TOKEN_MARGIN_MS)).toBeUndefined();
  });

  it('ACT-82 keys the entry by revision, so editing the target retires its token', () => {
    const cache = createTokenCache();
    cache.set('target-1', { revision: 3, token: 'first', expiresAt: HOUR_MS });
    expect(cache.get('target-1', 4, 0)).toBeUndefined();
    expect(cache.get('target-1', 3, 0)).toBeUndefined();
  });

  it('ACT-82 has nothing for an unknown target and forgets an invalidated one', () => {
    const cache = createTokenCache();
    expect(cache.get('target-2', 1, 0)).toBeUndefined();
    cache.set('target-2', { revision: 1, token: 'first', expiresAt: HOUR_MS });
    cache.invalidate('target-2');
    expect(cache.get('target-2', 1, 0)).toBeUndefined();
  });
});
