import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { OutputTail, scrubSecrets } from './serve-output.ts';

const SESSION_KEY = `${'A'.repeat(43)}==`;

describe('scrubSecrets', () => {
  it('VAULT-14 redacts session keys and password assignments however they are written', () => {
    expect(scrubSecrets(`$ export BW_SESSION="${SESSION_KEY}"`)).toBe(
      '$ export BW_SESSION=[REDACTED]',
    );
    expect(scrubSecrets("bw_session='short'")).toBe('bw_session=[REDACTED]');
    expect(scrubSecrets('password: hunter2 and Password=h2')).toBe(
      'password: [REDACTED] and Password=[REDACTED]',
    );
    expect(scrubSecrets(`token ${SESSION_KEY} inline`)).toBe('token [REDACTED] inline');
    expect(scrubSecrets(`${'x'.repeat(39)} stays`)).toBe(`${'x'.repeat(39)} stays`);
  });
});

describe('OutputTail', () => {
  it('is empty until something is written', () => {
    expect(new OutputTail().text()).toBe('');
  });

  it('joins chunks that split a line and drops the trailing newline', () => {
    const tail = new OutputTail();
    tail.push('first li');
    tail.push('ne\nsecond\n');
    expect(tail.text()).toBe('first line\nsecond');
  });

  it('keeps only the last forty lines', () => {
    const tail = new OutputTail();
    for (let line = 1; line <= 50; line += 1) {
      tail.push(`line ${line}\n`);
    }
    const lines = tail.text().split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe('line 11');
    expect(lines[39]).toBe('line 50');
  });

  it('keeps only the last 4 KiB', () => {
    const tail = new OutputTail();
    tail.push(`${'a '.repeat(1500)}\n${'b '.repeat(1500)}`);
    expect(tail.text()).toHaveLength(4095);
    expect(tail.text().startsWith(' a a ')).toBe(true);
    expect(tail.text().endsWith(' b b')).toBe(true);
    tail.push(`${'c '.repeat(2500)}end`);
    expect(tail.text()).toHaveLength(4096);
    expect(tail.text()).toMatch(/^ (?:c )+end$/);
  });

  it('reads every attached stream and ignores a missing one', async () => {
    const tail = new OutputTail();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    tail.attach(stdout, null, stderr);
    stdout.write('out\n');
    stderr.end('err\n');
    stdout.end();
    await new Promise((resolve) => {
      stderr.once('end', resolve);
    });
    expect(tail.text()).toContain('out');
    expect(tail.text()).toContain('err');
    expect(tail.text()).toHaveLength('out\nerr'.length);
  });
});
