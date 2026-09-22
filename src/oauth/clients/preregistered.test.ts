import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../../test-support/result.ts';

import { validatePreregisteredClients } from './preregistered.ts';

const options = { now: 5, newId: () => 'id-1' };

describe('validatePreregisteredClients', () => {
  it('OAUTH-12 maps valid clients to persisted records', () => {
    const records = unwrapOk(
      validatePreregisteredClients(
        [{ clientId: 'desk', clientName: 'Desk', redirectUris: ['https://desk.example.com/cb'] }],
        options,
      ),
    );
    expect(records).toStrictEqual([
      {
        id: 'id-1',
        clientId: 'desk',
        mode: 'preregistered',
        clientName: 'Desk',
        redirectUris: ['https://desk.example.com/cb'],
        metadata: {},
        createdAt: 5,
        revokedAt: undefined,
      },
    ]);
  });

  it('OAUTH-12 reports every problem at once', () => {
    const error = unwrapFail(
      validatePreregisteredClients(
        [
          { clientId: 'dup', clientName: undefined, redirectUris: ['http://evil.example.com/cb'] },
          { clientId: 'dup', clientName: undefined, redirectUris: ['https://ok.example.com/cb'] },
          { clientId: 'https://cimd.example.com/c.json', clientName: undefined, redirectUris: ['https://ok.example.com/cb'] },
          { clientId: 'vg_c_reserved', clientName: undefined, redirectUris: ['https://ok.example.com/cb'] },
        ],
        options,
      ),
    );
    expect(error.name).toBe('PreregisteredClientsError');
    expect(error.issues).toStrictEqual([
      'client "dup": redirect URI "http://evil.example.com/cb" must use https or a loopback http address',
      'client "dup" is listed twice',
      'client "https://cimd.example.com/c.json": an https URL client_id is reserved for CIMD',
      'client "vg_c_reserved": the vg_c_ prefix is reserved for dynamic clients',
    ]);
    expect(error.message).toContain('Invalid VAULTGATE_OAUTH_CLIENTS:');
  });

  it('OAUTH-12 treats an unparsable client_id as a plain identifier', () => {
    expect(
      unwrapOk(validatePreregisteredClients([{ clientId: 'not a url', clientName: undefined, redirectUris: ['https://ok.example.com/cb'] }], options)),
    ).toHaveLength(1);
  });
});
