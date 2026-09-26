/**
 * ACT-51 for a call over several targets (ACT-110): every target's scrub
 * table applies to the one answer, each in turn, so a value injected for one
 * repository is redacted wherever the answer carries it. Each table stays
 * live, so a value a run adds to one (the archive redirect of ACT-104)
 * joins at once. A capped buffer is scrubbed by every table first and cut
 * once, by the first, after all of them (ACT-52).
 */
import type { CappedText, Scrubber } from './scrub.ts';

export function combineScrubbers(first: Scrubber, rest: readonly Scrubber[]): Scrubber {
  const all = [first, ...rest];
  const others = (input: Buffer): Buffer =>
    rest.reduce((value, scrub) => scrub.bytes(value), input);
  const capped = (
    input: Buffer,
    cut: (scrubbed: Buffer) => CappedText,
    maxBytes: number,
  ): CappedText => {
    const result = cut(others(input));
    return {
      ...result,
      truncated: result.truncated || input.length > maxBytes,
      bytes: input.length,
    };
  };
  return {
    get guardBytes() {
      return Math.max(...all.map((scrub) => scrub.guardBytes));
    },
    text: (input) => all.reduce((value, scrub) => scrub.text(value), input),
    bytes: (input) => all.reduce((value, scrub) => scrub.bytes(value), input),
    buffer: (input, maxBytes) =>
      capped(input, (scrubbed) => first.buffer(scrubbed, maxBytes), maxBytes),
    base64: (input, maxBytes) =>
      capped(input, (scrubbed) => first.base64(scrubbed, maxBytes), maxBytes),
    deep: <T>(value: T): T => all.reduce((current, scrub) => scrub.deep(current), value),
  };
}
