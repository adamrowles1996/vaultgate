import { describe, expect, it } from 'vitest';

import { FakeSpawner, type SpawnRecord } from '../test-support/fake-child-process.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { Credentials } from './credentials.ts';
import { BwCli, VersionRefusedError } from './serve-process.ts';

const ENVIRONMENT = {
  PATH: '/usr/bin',
  HOME: '/home/vaultgate',
  BW_SESSION: 'leaked-session',
  VAULTGATE_BW_PASSWORD: 'leaked-password',
};

function cliWith(
  spawner: FakeSpawner,
  clock = new ManualClock(),
  environment: Readonly<Record<string, string | undefined>> = ENVIRONMENT,
): BwCli {
  return new BwCli({
    bin: '/opt/bw/bw',
    appDataDirectory: '/data/bw/1',
    environment,
    spawn: spawner.spawn,
    clock,
  });
}

function finishing(stdout: string, code = 0): (record: SpawnRecord) => void {
  return ({ child }) => {
    child.finish(stdout, code);
  };
}

describe('BwCli environment', () => {
  it('VAULT-1 passes only PATH, HOME and TMPDIR plus the app-data directory', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('2026.9.0\n') });
    await cliWith(spawner, new ManualClock(), { ...ENVIRONMENT, TMPDIR: '/tmp/x' }).version();
    expect(spawner.records[0]).toMatchObject({
      command: '/opt/bw/bw',
      argv: ['--version'],
      environment: {
        PATH: '/usr/bin',
        HOME: '/home/vaultgate',
        TMPDIR: '/tmp/x',
        BITWARDENCLI_APPDATA_DIR: '/data/bw/1',
        BW_NOINTERACTION: 'true',
      },
    });
    expect(Object.keys(spawner.records[0]!.environment)).toHaveLength(5);
  });

  it('omits inherited variables that are unset', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('2026.9.0\n') });
    await cliWith(spawner, new ManualClock(), { PATH: '/usr/bin' }).version();
    expect(Object.keys(spawner.records[0]!.environment)).toStrictEqual([
      'PATH',
      'BITWARDENCLI_APPDATA_DIR',
      'BW_NOINTERACTION',
    ]);
  });
});

describe('BwCli.version', () => {
  it('VAULT-2 parses the version', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('2026.9.0\n') });
    expect(unwrapOk(await cliWith(spawner).version())).toStrictEqual({
      major: 2026,
      minor: 9,
      patch: 0,
    });
  });

  it('VAULT-2 refuses a version below the minimum', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('2024.1.0\n') });
    const error = unwrapFail(await cliWith(spawner).version());
    expect(error).toBeInstanceOf(VersionRefusedError);
    expect(error.name).toBe('VersionRefusedError');
    expect(error.message).toBe('bw 2024.1.0 is older than the minimum 2025.1.0');
  });

  it('fails on output without a version', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('who knows\n') });
    expect(unwrapFail(await cliWith(spawner).version()).message).toBe(
      'bw --version printed no recognisable version',
    );
  });

  it('fails on a non-zero exit status', async () => {
    const spawner = new FakeSpawner({ '--version': finishing('', 2) });
    expect(unwrapFail(await cliWith(spawner).version()).message).toBe(
      'bw --version exited with status 2',
    );
  });

  it('fails when the child dies by signal', async () => {
    const spawner = new FakeSpawner({
      '--version': ({ child }) => {
        child.exit(null, 'SIGSEGV');
      },
    });
    expect(unwrapFail(await cliWith(spawner).version()).message).toBe(
      'bw --version exited with status null',
    );
  });

  it('VAULT-5 fails when the binary cannot be spawned', async () => {
    const spawner = new FakeSpawner({
      '--version': ({ child }) => {
        child.fail(new Error('spawn /opt/bw/bw ENOENT'));
      },
    });
    expect(unwrapFail(await cliWith(spawner).version()).message).toBe('spawn /opt/bw/bw ENOENT');
  });

  it('kills a command that does not finish within a minute', async () => {
    const spawner = new FakeSpawner();
    const clock = new ManualClock();
    const pending = cliWith(spawner, clock).version();
    await clock.advance(60_000);
    expect(unwrapFail(await pending).message).toBe('bw --version did not finish within 60000 ms');
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGKILL']);
  });
});

describe('BwCli.abort', () => {
  it('VAULT-7 kills commands still running so shutdown does not wait on them', async () => {
    const spawner = new FakeSpawner();
    const cli = cliWith(spawner);
    const pending = cli.version();
    cli.abort();
    expect(unwrapFail(await pending).message).toBe('bw --version exited with status null');
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGKILL']);
    cli.abort();
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGKILL']);
  });
});

describe('BwCli.configureServer', () => {
  it('VAULT-3 runs bw config server', async () => {
    const spawner = new FakeSpawner({ config: finishing('Saved setting `config`.\n') });
    expect(await cliWith(spawner).configureServer('https://vault.example.test')).toStrictEqual({
      ok: true,
      value: undefined,
    });
    expect(spawner.records[0]!.argv).toStrictEqual([
      'config',
      'server',
      'https://vault.example.test',
    ]);
  });

  it('reports a failure', async () => {
    const spawner = new FakeSpawner({ config: finishing('', 1) });
    expect(unwrapFail(await cliWith(spawner).configureServer('bitwarden.eu')).message).toBe(
      'bw config exited with status 1',
    );
  });
});

describe('BwCli.status', () => {
  it('parses the status JSON', async () => {
    const spawner = new FakeSpawner({
      status: finishing('{"serverUrl":null,"lastSync":null,"status":"unauthenticated"}'),
    });
    expect(unwrapOk(await cliWith(spawner).status())).toStrictEqual({
      serverUrl: null,
      lastSync: null,
      status: 'unauthenticated',
    });
  });

  it('fails on output that is not a status', async () => {
    const spawner = new FakeSpawner({ status: finishing('null') });
    expect(unwrapFail(await cliWith(spawner).status()).message).toBe(
      'bw status printed no status JSON',
    );
    const broken = new FakeSpawner({ status: finishing('{not json') });
    expect(unwrapFail(await cliWith(broken).status()).message).toBe(
      'bw status printed no status JSON',
    );
  });
});

describe('BwCli.login', () => {
  it('VAULT-4 passes the api key to that child only', async () => {
    const spawner = new FakeSpawner({ login: finishing('You are logged in!\n') });
    const credentials = new Credentials({
      clientId: 'user.abc',
      masterPassword: 'master-pw',
      clientSecret: 'client-secret',
      server: undefined,
    });
    const cli = cliWith(spawner);
    expect(await cli.login(credentials)).toStrictEqual({ ok: true, value: undefined });
    expect(spawner.records[0]).toMatchObject({
      argv: ['login', '--apikey'],
      environment: { BW_CLIENTID: 'user.abc', BW_CLIENTSECRET: 'client-secret' },
    });
    cli.serve(4242);
    expect(spawner.records[1]!.environment).not.toHaveProperty('BW_CLIENTSECRET');
    expect(spawner.records[1]!.environment).not.toHaveProperty('BW_CLIENTID');
  });

  it('reports a rejected login without the secret', async () => {
    const spawner = new FakeSpawner({ login: finishing('', 1) });
    const error = unwrapFail(
      await cliWith(spawner).login(
        new Credentials({
          clientId: 'user.abc',
          masterPassword: 'pw',
          clientSecret: 'client-secret',
          server: undefined,
        }),
      ),
    );
    expect(error.message).toBe('bw login exited with status 1');
  });
});
