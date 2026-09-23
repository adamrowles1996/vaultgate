import { describe, expect, it } from 'vitest';

import { FakeSpawner } from '../test-support/fake-child-process.ts';
import { ManualClock } from '../test-support/manual-clock.ts';

import { BwCli, spawnChild } from './serve-process.ts';

function cliWith(spawner: FakeSpawner, clock = new ManualClock()): BwCli {
  return new BwCli({
    bin: '/opt/bw/bw',
    dataDir: '/data',
    environment: { PATH: '/usr/bin', HOME: '/home/vaultgate' },
    spawn: spawner.spawn,
    clock,
  });
}

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

  it('VAULT-6 keeps a scrubbed tail of what the child wrote', async () => {
    const spawner = new FakeSpawner();
    const handle = cliWith(spawner).serve(1);
    const child = spawner.records[0]!.child;
    child.stdout.write('serving on 127.0.0.1\n');
    child.stderr.write(`$ export BW_SESSION="${'k'.repeat(88)}"\n`);
    child.stderr.write('Error: connection reset\n');
    child.exit(1);
    await expect(handle.exited).resolves.toStrictEqual({ code: 1, signal: null });
    const output = handle.output();
    expect(output).toContain('serving on 127.0.0.1');
    expect(output).toContain('$ export BW_SESSION=[REDACTED]\nError: connection reset');
    expect(output).not.toContain('kkkk');
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
    const spawner = new FakeSpawner();
    const clock = new ManualClock();
    const handle = cliWith(spawner, clock).serve(1);
    await handle.stop();
    expect(spawner.records[0]!.child.signals).toStrictEqual(['SIGTERM']);
    await expect(handle.exited).resolves.toStrictEqual({ code: null, signal: 'SIGTERM' });
    expect(clock.pending()).toBe(0);
  });

  it('VAULT-7 escalates to SIGKILL after five seconds', async () => {
    const spawner = new FakeSpawner({
      serve: ({ child }) => {
        child.ignore('SIGTERM');
      },
    });
    const clock = new ManualClock();
    const handle = cliWith(spawner, clock).serve(1);
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
