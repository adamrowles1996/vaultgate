/**
 * The last few lines `bw serve` wrote, kept so an unexpected exit can be
 * explained rather than guessed at (VAULT-6). The tail is bounded, and
 * anything that looks like a session key or a password is scrubbed before
 * the text can reach a log line (VAULT-14).
 */
import type { Readable } from 'node:stream';

const MAX_LINES = 40;
const MAX_CHARACTERS = 4096;
const REDACTED = '[REDACTED]';

/**
A session key or similar token: forty or more base64 (or base64url) characters in a row.
*/
const LONG_TOKEN = /[\w+/=-]{40,}/g;

/**
`BW_SESSION="…"` (the CLI prints it after an unlock) or any `password=…` / `password: …`.
*/
const SECRET_ASSIGNMENT = /\b(BW_SESSION|password)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

export function scrubSecrets(text: string): string {
  return text
    .replaceAll(SECRET_ASSIGNMENT, (_match, name: string, separator: string) =>
      [name, separator, REDACTED].join(''),
    )
    .replaceAll(LONG_TOKEN, () => REDACTED);
}

/**
Collects a stream's output and keeps only the last `MAX_LINES` lines or `MAX_CHARACTERS` characters.
*/
export class OutputTail {
  #text = '';

  attach(...streams: readonly (Readable | null)[]): void {
    for (const stream of streams) {
      stream?.on('data', (chunk: Buffer | string) => {
        this.push(chunk.toString());
      });
    }
  }

  push(chunk: string): void {
    const text = (this.#text + chunk).slice(-MAX_CHARACTERS);
    const lines = text.split('\n');
    // A trailing newline ends the last line rather than starting an empty one.
    const keep = text.endsWith('\n') ? MAX_LINES + 1 : MAX_LINES;
    this.#text = lines.slice(-keep).join('\n');
  }

  /**
  The tail with secrets scrubbed; empty when the child wrote nothing.
  */
  text(): string {
    return scrubSecrets(this.#text).trimEnd();
  }
}
