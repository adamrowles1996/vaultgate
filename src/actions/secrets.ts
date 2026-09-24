/**
 * The secrets one call holds (spec §13.9): the values fetched from the vault
 * before the run (ACT-50) and any the connector obtains during it — the
 * `graph` access token and a rotated refresh token (ACT-82, ACT-83). Adding
 * one extends the scrub table immediately, so a value obtained mid-call is
 * redacted from the output of that same call (ACT-51), and its buffer is
 * zeroed with the rest when the call ends.
 */
import { createScrubber, type InjectedEntry, type InjectedValues, type Scrubber } from './scrub.ts';

export interface SecretHolder {
  readonly injected: InjectedValues;
  /**
  A live view: it redacts every value held at the moment it is asked, not at construction.
  */
  readonly scrub: Scrubber;
  add(entry: InjectedEntry): void;
}

export function createSecretHolder(
  entries: readonly InjectedEntry[],
  username: string | undefined,
): SecretHolder {
  const held = [...entries];
  const fields = [...new Set(held.map((entry) => entry.field))];
  const values = new Map(held.map((entry) => [entry.field, entry.value]));
  let scrubber = createScrubber(held, username);
  const injected: InjectedValues = {
    fields,
    username,
    value: (field) => values.get(field),
    dispose() {
      // `held`, not `values`: a field written twice (a rotated refresh token)
      // leaves the replaced buffer out of the map, and it must be zeroed too.
      for (const entry of held) {
        entry.value.fill(0);
      }
    },
  };
  return {
    injected,
    scrub: {
      get guardBytes() {
        return scrubber.guardBytes;
      },
      text: (input) => scrubber.text(input),
      bytes: (input) => scrubber.bytes(input),
      buffer: (input, maxBytes) => scrubber.buffer(input, maxBytes),
      base64: (input, maxBytes) => scrubber.base64(input, maxBytes),
      deep: (value) => scrubber.deep(value),
    },
    add(entry) {
      held.push(entry);
      if (!values.has(entry.field)) {
        fields.push(entry.field);
      }
      values.set(entry.field, entry.value);
      scrubber = createScrubber(held, username);
    },
  };
}
