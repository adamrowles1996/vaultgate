/**
 * ACT-43: the excerpt of an operation a human is shown before approving it.
 *
 * The summary is the last line of defence against a prompt-injected agent
 * talking an honest human into a call, so it may never be quietly shortened:
 * a person who ticks a box for text whose operative clause was cut has been
 * given the appearance of consent without its substance. An operation longer
 * than the cap is therefore shown as its head **and its tail** — a payload
 * appended to a long prelude is the shape that hides best behind a head-only
 * cut — and what is missing is reported as a count and a SHA-256 of the whole
 * of it, which the caller renders where the agent's own text cannot reach.
 */
import { createHash } from 'node:crypto';

const SUMMARY_CAP = 1024;
const HEAD_CHARACTERS = 768;
const TAIL_CHARACTERS = 192;
const ELLIPSIS = '\n…\n';

/**
What the summary leaves out, for the caller to say out loud (ACT-43).
*/
export interface OmittedText {
  readonly characters: number;
  readonly total: number;
  readonly sha256: string;
}

export interface OperationExcerpt {
  readonly summary: string;
  /**
  Absent when the whole operation is shown.
  */
  readonly omitted?: OmittedText;
}

export function excerptOf(text: string): OperationExcerpt {
  if (text.length <= SUMMARY_CAP) {
    return { summary: text };
  }
  const head = text.slice(0, HEAD_CHARACTERS);
  const tail = text.slice(text.length - TAIL_CHARACTERS);
  return {
    summary: `${head}${ELLIPSIS}${tail}`,
    omitted: {
      characters: text.length - HEAD_CHARACTERS - TAIL_CHARACTERS,
      total: text.length,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    },
  };
}
