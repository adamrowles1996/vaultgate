import { describe, expect, it, vi } from 'vitest';

import { Credentials } from './credentials.ts';

const VALUES = {
  clientId: 'user.abc',
  masterPassword: 'master-pw',
  clientSecret: 'client-secret',
  server: 'bitwarden.eu',
};

describe('Credentials', () => {
  it('hands back the secrets it was given', () => {
    const credentials = new Credentials(VALUES);
    expect(credentials.clientId).toBe('user.abc');
    expect(credentials.server).toBe('bitwarden.eu');
    expect(credentials.masterPassword()).toBe('master-pw');
    expect(credentials.clientSecret()).toBe('client-secret');
    expect(credentials.disposed).toBe(false);
  });

  it('VAULT-15 serialises to nothing but the client id', () => {
    const credentials = new Credentials(VALUES);
    expect(JSON.stringify(credentials)).toBe('{"clientId":"user.abc","server":"bitwarden.eu"}');
    expect(Object.keys(credentials)).toStrictEqual(['clientId', 'server']);
  });

  it('VAULT-15 zero-fills both secrets on dispose and refuses reads afterwards', () => {
    const credentials = new Credentials(VALUES);
    credentials.dispose();
    expect(credentials.disposed).toBe(true);
    expect(() => credentials.masterPassword()).toThrow('credentials have been disposed');
    expect(() => credentials.clientSecret()).toThrow('credentials have been disposed');
  });

  it('VAULT-15 overwrites the underlying buffers rather than dropping references', () => {
    const credentials = new Credentials(VALUES);
    const seen: string[] = [];
    const fill = vi.spyOn(Buffer.prototype, 'fill').mockImplementation(function (this: Buffer) {
      seen.push(this.toString('utf8'));
      return this;
    });
    credentials.dispose();
    expect(fill).toHaveBeenCalledTimes(2);
    expect(seen).toStrictEqual(['master-pw', 'client-secret']);
  });
});
