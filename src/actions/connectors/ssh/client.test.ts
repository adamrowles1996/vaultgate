import { describe, expect, it } from 'vitest';

import { hostKeyBlob, HOST_KEYS } from '../../../test-support/fake-ssh-client.ts';
import { answerChannel, connectedWith, FakeSsh2Client } from '../../../test-support/fake-ssh2.ts';
import { ActionError } from '../../errors.ts';

import { loadSshDriver, openSshSession, sshSession } from './client.ts';

import type { SshConnection, SshSession } from './session.ts';

function connection(overrides: Partial<SshConnection> = {}): SshConnection {
  return {
    host: 'build.example.com',
    address: '93.184.216.34',
    port: 22,
    username: 'vaultgate',
    hostKey: HOST_KEYS.pinned,
    auth: { kind: 'key', privateKey: 'PRIVATE KEY', passphrase: undefined },
    connectTimeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function ready(
  client: FakeSsh2Client,
  overrides: Partial<SshConnection> = {},
): Promise<SshSession> {
  const opening = openSshSession(() => client, connection(overrides));
  client.ready();
  return opening;
}

describe('opening an ssh connection', () => {
  it('ACT-55 connects to the address the engine pinned, never resolving the host name itself', async () => {
    const client = new FakeSsh2Client();
    await ready(client);
    expect(connectedWith(client)).toMatchObject({
      host: '93.184.216.34',
      port: 22,
      username: 'vaultgate',
      readyTimeout: 30_000,
    });
  });

  it('ACT-28 offers only the one authentication method the mapping names, so no agent or keyboard step can follow', async () => {
    const key = new FakeSsh2Client();
    await ready(key);
    expect(connectedWith(key)).toMatchObject({
      authHandler: ['publickey'],
      privateKey: 'PRIVATE KEY',
      agentForward: false,
      tryKeyboard: false,
    });
    expect(connectedWith(key).passphrase).toBeUndefined();
    expect(connectedWith(key).password).toBeUndefined();
    const password = new FakeSsh2Client();
    await ready(password, { auth: { kind: 'password', password: 'PASSWORD' } });
    expect(connectedWith(password)).toMatchObject({
      authHandler: ['password'],
      password: 'PASSWORD',
    });
  });

  it('ACT-87 carries the key passphrase when the mapping has one', async () => {
    const client = new FakeSsh2Client();
    await ready(client, {
      auth: { kind: 'key', privateKey: 'PRIVATE KEY', passphrase: 'PASSPHRASE' },
    });
    expect(connectedWith(client).passphrase).toBe('PASSPHRASE');
  });

  it('ACT-87 removes ssh-rsa from the host key algorithms and leaves the modern ciphers and key exchanges alone', async () => {
    const client = new FakeSsh2Client();
    await ready(client);
    expect(connectedWith(client).algorithms).toStrictEqual({
      serverHostKey: { append: [], prepend: [], remove: ['ssh-rsa'] },
    });
  });

  it('ACT-87 accepts the pinned key and refuses any other, before the credential is sent', async () => {
    const client = new FakeSsh2Client();
    const opening = openSshSession(() => client, connection());
    const { hostVerifier } = connectedWith(client);
    expect(hostVerifier(hostKeyBlob(HOST_KEYS.pinned))).toBe(true);
    client.ready();
    await opening;

    const wrong = new FakeSsh2Client();
    const refused = openSshSession(() => wrong, connection());
    expect(connectedWith(wrong).hostVerifier(hostKeyBlob(HOST_KEYS.other))).toBe(false);
    wrong.fail(Object.assign(new Error('Handshake failed'), { level: 'handshake' }));
    await expect(refused).rejects.toThrow(new ActionError('host_key_mismatch'));
    expect(wrong.ends).toBe(1);
  });

  it('ACT-74 reports a failure before the handshake as itself', async () => {
    const client = new FakeSsh2Client();
    const opening = openSshSession(() => client, connection());
    client.fail(
      Object.assign(new Error('refused'), { level: 'client-socket', code: 'ECONNREFUSED' }),
    );
    await expect(opening).rejects.toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'ECONNREFUSED' },
    });
  });
});

describe('running a command over the connection', () => {
  it('ACT-28 opens one exec channel with no terminal, no X11 and no environment, and ends the connection on close', async () => {
    const client = new FakeSsh2Client();
    const session = await ready(client);
    const result = session.exec({ command: 'uptime', stdin: 'input', captureBytes: 1024 });
    answerChannel(client.channel, { stdout: 'up 3 days', exitCode: 0 });
    expect(await result).toMatchObject({ exitCode: 0, truncated: false });
    expect(client.execs).toStrictEqual([
      { command: 'uptime', options: { pty: false, x11: false, env: {} } },
    ]);
    expect(client.channel.written).toStrictEqual(['input']);
    session.close();
    expect(client.ends).toBe(1);
  });

  it('ACT-74 reports a channel the server refused to open as upstream_error', async () => {
    const client = new FakeSsh2Client();
    client.execError = new Error('Unable to open channel');
    const session = await ready(client);
    await expect(
      session.exec({ command: 'uptime', stdin: undefined, captureBytes: 1024 }),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      detail: { message: 'Unable to open channel' },
    });
  });
});

describe('loadSshDriver', () => {
  it('ACT-73 imports ssh2 only when a call runs, and builds a client that is never connected here', async () => {
    const driver = await loadSshDriver();
    const client = driver();
    expect(typeof client.connect).toBe('function');
    client.end();
  });

  it('ACT-78 opens the session over the loaded driver by default', async () => {
    const client = new FakeSsh2Client();
    const opening = sshSession(connection(), () => Promise.resolve(() => client));
    await Promise.resolve();
    client.ready();
    const session = await opening;
    expect(typeof session.exec).toBe('function');
  });
});
