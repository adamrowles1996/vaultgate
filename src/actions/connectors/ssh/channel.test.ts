import { describe, expect, it } from 'vitest';

import { answerChannel, FakeSsh2Channel } from '../../../test-support/fake-ssh2.ts';

import { collectChannel } from './channel.ts';

import type { SshCommand } from './session.ts';

const REQUEST: SshCommand = { command: 'uptime', stdin: undefined, captureBytes: 16 };

function collect(
  channel: FakeSsh2Channel,
  overrides: Partial<SshCommand> = {},
  signal?: AbortSignal,
) {
  return collectChannel(
    channel,
    { ...REQUEST, ...overrides },
    signal ?? new AbortController().signal,
  );
}

describe('collecting one exec channel', () => {
  it('ACT-27 writes the standard input and closes it, so a command that reads to end of file finishes', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel, { stdin: 'hello' });
    answerChannel(channel, { exitCode: 0 });
    await result;
    expect(channel.written).toStrictEqual(['hello']);
  });

  it('ACT-27 closes standard input with nothing written when the call gives none', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel);
    answerChannel(channel, { exitCode: 0 });
    await result;
    expect(channel.written).toStrictEqual(['']);
  });

  it('ACT-27 keeps the two streams apart and reports the exit status', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel);
    answerChannel(channel, { stdout: 'out', stderr: 'err', exitCode: 3 });
    expect(await result).toStrictEqual({
      exitCode: 3,
      stdout: Buffer.from('out'),
      stderr: Buffer.from('err'),
      truncated: false,
    });
  });

  it('ACT-27 answers a null exit code when the command was signalled rather than exiting', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel);
    answerChannel(channel, { stdout: 'partial', signalled: true });
    expect(await result).toMatchObject({ exitCode: null });
  });

  it('ACT-27 answers a null exit code when the channel closed without any exit at all', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel);
    channel.close();
    expect(await result).toMatchObject({ exitCode: null, truncated: false });
  });

  it('ACT-52 caps each stream on its own, keeping the bytes up to the cut and saying truncated', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel, { captureBytes: 4 });
    channel.write('abcdef');
    channel.stderr.write('xy');
    channel.close();
    expect(await result).toStrictEqual({
      exitCode: null,
      stdout: Buffer.from('abcd'),
      stderr: Buffer.from('xy'),
      truncated: true,
    });
  });

  it('ACT-52 drops a whole chunk that arrives after the cap is full', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel, { captureBytes: 2 });
    channel.write('ab');
    channel.write('cd');
    channel.close();
    expect(await result).toMatchObject({ stdout: Buffer.from('ab'), truncated: true });
  });

  it('ACT-52 says truncated when it is the standard error stream that overran', async () => {
    const channel = new FakeSsh2Channel();
    const result = collect(channel, { captureBytes: 2 });
    channel.stderr.write('abc');
    channel.close();
    expect(await result).toMatchObject({ stderr: Buffer.from('ab'), truncated: true });
  });

  it('ACT-59 kills the remote command and answers timeout when the call runs out of time', async () => {
    const channel = new FakeSsh2Channel();
    const controller = new AbortController();
    const result = collect(channel, {}, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'timeout' });
    expect(channel.signals).toStrictEqual(['KILL']);
  });

  it('ACT-59 answers timeout without waiting when the call was already out of time', async () => {
    const channel = new FakeSsh2Channel();
    const controller = new AbortController();
    controller.abort();
    await expect(collect(channel, {}, controller.signal)).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(channel.signals).toStrictEqual(['KILL']);
    expect(channel.written).toStrictEqual([]);
  });

  it('ACT-59 still answers timeout when the channel has already gone and cannot be signalled', async () => {
    const channel = new FakeSsh2Channel();
    channel.isBroken = true;
    const controller = new AbortController();
    const result = collect(channel, {}, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'timeout' });
  });

  it('ACT-74 reports a channel error as upstream_error and stops listening for the timeout', async () => {
    const channel = new FakeSsh2Channel();
    const controller = new AbortController();
    const result = collect(channel, {}, controller.signal);
    channel.fail(new Error('broken pipe'));
    await expect(result).rejects.toMatchObject({
      code: 'upstream_error',
      detail: { message: 'broken pipe' },
    });
    controller.abort();
    expect(channel.signals).toStrictEqual([]);
  });
});
