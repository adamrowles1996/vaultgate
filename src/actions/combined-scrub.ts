/**
 * ACT-51 for a call over several targets (ACT-110): every target's scrub
 * table applies to the one answer, each in turn, so a value injected for one
 * repository is redacted wherever the answer carries it. Each table stays
 * live, so a value a run adds to one (the archive redirect of ACT-104)
 * joins at once.
 */
import type { CappedText, Scrubber } from './scrub.ts';

export function combineScrubbers(scrubbers: readonly Scrubber[]): Scrubber {
  const [last] = scrubbers.slice(-1);
  const before = scrubbers.slice(0, -1);
  const bytes = (input: Buffer): Buffer =>
    before.reduce((value, scrub) => scrub.bytes(value), input);
  const capped = (input: Buffer, maxBytes: number, cut: 'buffer' | 'base64'): CappedText => {
    if (last === undefined) {
      return { text: input.toString('utf8'), truncated: false, bytes: input.byteLength };
    }
    const result = last[cut](bytes(input), maxBytes);
    return { ...result, bytes: input.byteLength };
  };
  return {
    get guardBytes() {
      return Math.max(0, ...scrubbers.map((scrub) => scrub.guardBytes));
    },
    text: (input) => scrubbers.reduce((value, scrub) => scrub.text(value), input),
    bytes: (input) => scrubbers.reduce((value, scrub) => scrub.bytes(value), input),
    buffer: (input, maxBytes) => capped(input, maxBytes, 'buffer'),
    base64: (input, maxBytes) => capped(input, maxBytes, 'base64'),
    deep: <T>(value: T): T => scrubbers.reduce((current, scrub) => scrub.deep(current), value),
  };
}
