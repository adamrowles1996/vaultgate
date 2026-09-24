/**
 * One rule, shared by every operation argument an agent writes as text: a C0
 * control character other than tab, line feed and carriage return is refused.
 * ACT-27 states it for `command` — XML 1.0 cannot carry the rest even as a
 * character reference, so a `winrm` command holding one could not be sent at
 * all, and on `ssh` one is a mistake or an attempt at a terminal escape — and
 * ACT-23 states it for `statement`, where the reason is the tokeniser: it is a
 * control in depth behind ACT-85's least-privilege login (ACT-38), and every
 * character it must agree with the server's lexer about that no statement
 * legitimately contains is a divergence waiting to be found.
 */
const NUL = '\u{0}';

const CONTROL_CHARACTERS: ReadonlySet<string> = new Set(
  Array.from({ length: 32 }, (_value, code) => String.fromCodePoint(code)).filter(
    (character) => !'\t\n\r'.includes(character),
  ),
);

export function hasNul(text: string): boolean {
  return text.includes(NUL);
}

export function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    if (CONTROL_CHARACTERS.has(character)) {
      return true;
    }
  }
  return false;
}
