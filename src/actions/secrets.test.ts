import { describe, expect, it } from 'vitest';

import { createSecretHolder } from './secrets.ts';

describe('createSecretHolder', () => {
  it('ACT-50 exposes the buffers by field and zeroes every one on dispose', () => {
    const password = Buffer.from('hunter2');
    const holder = createSecretHolder([{ field: 'password', value: password }], 'alice');
    expect(holder.injected.fields).toStrictEqual(['password']);
    expect(holder.injected.username).toBe('alice');
    expect(holder.injected.value('password')).toBe(password);
    expect(holder.injected.value('totp')).toBeUndefined();
    holder.injected.dispose();
    expect(password.equals(Buffer.alloc(7, 0))).toBe(true);
  });

  it('ACT-51 redacts a value added during the call, and widens the guard band for it', () => {
    const holder = createSecretHolder(
      [{ field: 'password', value: Buffer.from('short') }],
      undefined,
    );
    expect(holder.scrub.text('a short token')).toBe('a [redacted:password] token');
    expect(holder.scrub.guardBytes).toBe(Buffer.from('short').toString('base64').length);
    holder.add({ field: 'graph.access_token', value: Buffer.from('a-much-longer-token') });
    expect(holder.scrub.text('a-much-longer-token')).toBe('[redacted:graph.access_token]');
    expect(holder.scrub.guardBytes).toBe(
      Buffer.from('a-much-longer-token').toString('base64').length,
    );
    expect(holder.scrub.deep({ at: 'a-much-longer-token' })).toStrictEqual({
      at: '[redacted:graph.access_token]',
    });
    expect(holder.scrub.buffer(Buffer.from('a-much-longer-token'), 1024).text).toBe(
      '[redacted:graph.access_token]',
    );
  });

  it('ACT-83 zeroes a field written twice, both the replaced buffer and the new one', () => {
    const before = Buffer.from('old-refresh-token');
    const after = Buffer.from('new-refresh-token');
    const holder = createSecretHolder([{ field: 'custom.refresh', value: before }], undefined);
    holder.add({ field: 'custom.refresh', value: after });
    expect(holder.injected.value('custom.refresh')).toBe(after);
    expect(holder.injected.fields).toStrictEqual(['custom.refresh']);
    holder.injected.dispose();
    expect(before.equals(Buffer.alloc(before.length, 0))).toBe(true);
    expect(after.equals(Buffer.alloc(after.length, 0))).toBe(true);
  });
});
