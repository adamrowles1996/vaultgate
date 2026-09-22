import { describe, expect, it } from 'vitest';

import {
  exitOnSigterm,
  FakeSpawner,
  type SpawnRecord,
} from '../test-support/fake-child-process.ts';
import { ManualClock } from '../test-support/manual-clock.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { Credentials } from './credentials.ts';
import { BwCli, spawnChild, VersionRefusedError } from './serve-process.ts';

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
    dataDir: '/data',
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
        BITWARDENCLI_APPDATA_DIR: '/data/bw',
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

  it('fails on unparsable output', async () => {
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
    const credentials = new Credentials('user.abc', 'master-pw', 'client-secret');
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
      await cliWith(spawner).login(new Credentials('user.abc', 'pw', 'client-secret')),
    );
    expect(error.message).toBe('bw login exited with status 1');
  });
});

describe('BwCli.serve', () => {
  it('VAULT-1 spawns bw serve bound to loopback on the given port', () => {
    const spawner = new FakeSpawner();
    const handle = cliWith(spawner).serve(43_210);
    expect(handle.endpoint).toBe('http://127.0.0.1:43210');
    expect(spawner.records[0]!.argv).toStrictEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '43210',
    ]);
  });

  it('reports how the child exited', async () => {
    const spawner = new FakeSpawner();
    const handle = cliWith(spawner).serve(1);
    spawner.records[0]!.child.exit(3);
    await expect(handle.exited).resolves.toStrictEqual({ code: 3, signal: null });
  });

  it('reports a spawn failure as an exit', async () => {
    const spawner = new FakeSpawner({
      serve: ({ child }) => {
        child.fail(new Error('ENOENT'));
      },
    });
    const handle = cliWith(spawner).serve(1);
    await expect(handle.exited).resolves.toStrictEqual({ code: null, signal: null });
  });

  it('VAULT-7 stops with SIGTERM when the child obeys', async () => {
    const spawner = new FakeSpawner({ serve: exitOnSigterm });
    const clock = new ManualClock();
    const handle = cliWith(spawner, clock).serve(1);
    await clock.settle();
    await handle.stop();
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGTERM']);
    await expect(handle.exited).resolves.toStrictEqual({ code: null, signal: 'SIGTERM' });
    expect(clock.pending()).toBe(0);
  });

  it('VAULT-7 escalates to SIGKILL after five seconds', async () => {
    const spawner = new FakeSpawner({
      serve: ({ child }) => {
        child.exitOn('SIGKILL');
      },
    });
    const clock = new ManualClock();
    const handle = cliWith(spawner, clock).serve(1);
    await clock.settle();
    const stopping = handle.stop();
    await clock.advance(4999);
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGTERM']);
    await clock.advance(1);
    await stopping;
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('spawnChild', () => {
  it('ARCH-2 spawns a real process with the given environment and piped output', async () => {
    const child = spawnChild(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.MARKER ?? "unset")'],
      { MARKER: 'from-vaultgate' },
    );
    const chunks: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('close', (exitCode) => {
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toBe('from-vaultgate');
  });
});
