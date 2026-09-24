/**
 * Secret handling (spec §13.9): the injected values a call holds (ACT-50),
 * the encoded variants of each (ACT-51) and their replacement in text and in
 * capped output with the guard band (ACT-52).
 */

export interface InjectedEntry {
  /**
  The field name the redaction marker names: `password`, `custom.api-key`, `totp`.
  */
  readonly field: string;
  readonly value: Buffer;
}

/**
 * What one call's secrets look like to a connector: the values are readable
 * only for the duration of `run`, and the engine zeroes them in `dispose`
 * afterwards (ACT-50). `src/actions/secrets.ts` owns the implementation.
 */
export interface InjectedValues {
  readonly fields: readonly string[];
  /**
  Known when the mapping names a username field; feeds the `basic` injection mode.
  */
  readonly username: string | undefined;
  value(field: string): Buffer | undefined;
  dispose(): void;
}

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  /**
  Bytes captured by the connector before scrubbing; the audit row's `output_bytes`.
  */
  readonly bytes: number;
}

export interface Scrubber {
  /**
  ACT-52: the longest variant in bytes; connectors capture `max_output_bytes` plus this.
  */
  readonly guardBytes: number;
  text(input: string): string;
  /**
   * ACT-51 over raw bytes, before anything encodes them. Every encoding
   * vaultgate itself applies — base64 above all, which is positional — has to
   * happen after this, or the scrub table matches nothing: none of a value's
   * variants appears in the base64 of a buffer that merely contains it.
   */
  bytes(input: Buffer): Buffer;
  /**
  Scrubs a captured buffer, then cuts it at `maxBytes` with `truncated: true`.
  */
  buffer(input: Buffer, maxBytes: number): CappedText;
  /**
  Scrubs a captured buffer's bytes, then cuts it to the largest base64 that fits `maxBytes`.
  */
  base64(input: Buffer, maxBytes: number): CappedText;
  /**
  Scrubs every string anywhere inside a JSON-like value, and every binary value as base64.
  */
  deep<T>(value: T): T;
}

export function redactionMarker(field: string): string {
  return `[redacted:${field}]`;
}

const BASE64_BLOCK = 4;
const BASE64_BYTES_PER_BLOCK = 3;
const HEX_DIGITS = 4;
const UTF16_UNIT_BYTES = 2;

/**
Anything outside printable ASCII (space to tilde), one code point at a time.
*/
const NON_PRINTABLE = /[^\u{20}-\u{7E}]/u;

function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
The `\uXXXX` escape of one character, one escape per UTF-16 unit as JSON encoders write it.
*/
function unitEscapes(character: string): string {
  const units = Buffer.from(character, 'utf16le');
  let output = '';
  for (let offset = 0; offset < units.length; offset += UTF16_UNIT_BYTES) {
    output += String.raw`\u${units.readUInt16LE(offset).toString(16).padStart(HEX_DIGITS, '0')}`;
  }
  return output;
}

/**
The JSON string escape with every character outside printable ASCII as `\uXXXX`, as an ASCII-only encoder writes it.
*/
function unicodeEscape(value: string): string {
  let output = '';
  for (const character of jsonEscape(value)) {
    output += NON_PRINTABLE.test(character) ? unitEscapes(character) : character;
  }
  return output;
}

function padded(base64: string): string {
  const remainder = base64.length % BASE64_BLOCK;
  return remainder === 0 ? base64 : base64 + '='.repeat(BASE64_BLOCK - remainder);
}

function unpadded(base64: string): string {
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') {
    end -= 1;
  }
  return base64.slice(0, end);
}

function byLengthDescending(left: string, right: string): number {
  return right.length - left.length;
}

/**
 * ACT-51: the raw value and every encoded form a destination could echo it
 * in. An empty value has no variants (it would match everything). Longer
 * variants come first so a shorter one never breaks a longer match.
 */
export function scrubVariants(value: string, username?: string): readonly string[] {
  if (value.length === 0) {
    return [];
  }
  const bytes = Buffer.from(value, 'utf8');
  const standard = bytes.toString('base64');
  const url = bytes.toString('base64url');
  const variants = new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams([['v', value]]).toString().slice(2),
    padded(standard),
    unpadded(standard),
    padded(url),
    unpadded(url),
    jsonEscape(value),
  ]);
  if (username !== undefined) {
    variants.add(Buffer.from(`${username}:${value}`, 'utf8').toString('base64'));
  }
  if (NON_PRINTABLE.test(value)) {
    variants.add(unicodeEscape(value));
  }
  return [...variants].toSorted(byLengthDescending);
}

interface Replacement {
  readonly variant: string;
  readonly marker: string;
}

/**
The replacement table with the set of characters any variant can begin with (ACT-51).
*/
interface Table {
  readonly entries: readonly Replacement[];
  readonly starts: ReadonlySet<string>;
}

function tableOf(entries: readonly Replacement[]): Table {
  return { entries, starts: new Set(entries.map((entry) => entry.variant.charAt(0))) };
}

/**
 * One left-to-right pass: at each position the longest variant that starts
 * there is replaced and the scan resumes after it, so a marker is never
 * itself scanned and a short value inside a longer one cannot break its
 * match. Linear in the input for a fixed table.
 */
function scrubText(table: Table, input: string): string {
  const parts: string[] = [];
  let literalFrom = 0;
  let index = 0;
  while (index < input.length) {
    // A variant can only begin here if its first character does, so the
    // common case — a position no variant starts at — costs one set lookup
    // rather than one `startsWith` per variant.
    const hit = table.starts.has(input.charAt(index))
      ? table.entries.find((entry) => input.startsWith(entry.variant, index))
      : undefined;
    if (hit === undefined) {
      index += 1;
      continue;
    }
    parts.push(input.slice(literalFrom, index), hit.marker);
    index += hit.variant.length;
    literalFrom = index;
  }
  parts.push(input.slice(literalFrom));
  return parts.join('');
}

/**
The two shapes a leaf can take: text, and the raw bytes of a binary column, which become base64.
*/
interface DeepScrubs {
  readonly text: (value: string) => string;
  readonly binary: (value: Uint8Array) => string;
}

function scrubDeep(value: unknown, scrubs: DeepScrubs): unknown {
  if (typeof value === 'string') {
    return scrubs.text(value);
  }
  if (value instanceof Uint8Array) {
    return scrubs.binary(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => scrubDeep(item, scrubs));
  }
  return value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, scrubs)]))
    : value;
}

/**
 * The byte table: every variant and marker as the latin1 reading of its UTF-8
 * bytes. latin1 maps each byte to one code point and back without loss, so the
 * text scan above does the byte work too, longest match first by byte length.
 */
function byteTable(entries: readonly Replacement[]): Table {
  return tableOf(
    entries
      .map((entry) => ({
        variant: Buffer.from(entry.variant, 'utf8').toString('latin1'),
        marker: Buffer.from(entry.marker, 'utf8').toString('latin1'),
      }))
      .toSorted((left, right) => byLengthDescending(left.variant, right.variant)),
  );
}

/**
ACT-52: the most whole base64 blocks of `input` that fit in `maxBytes` of encoded output.
*/
function base64Room(maxBytes: number): number {
  return Math.floor(maxBytes / BASE64_BLOCK) * BASE64_BYTES_PER_BLOCK;
}

/**
 * Exact-substring replacement of every variant of every injected value with
 * `[redacted:<field>]`, whatever the value's length (a short secret costs
 * false positives rather than a leak). The variants are copied out as
 * strings at construction, so the scrubber keeps working after the buffers
 * are zeroed (ACT-50) and error text can still be scrubbed at the very end.
 */
export function createScrubber(
  entries: readonly InjectedEntry[],
  username: string | undefined,
): Scrubber {
  const table = entries
    .flatMap((entry) =>
      scrubVariants(entry.value.toString('utf8'), username).map((variant) => ({
        variant,
        marker: redactionMarker(entry.field),
      })),
    )
    .toSorted((left, right) => byLengthDescending(left.variant, right.variant));
  const guardBytes = Math.max(0, ...table.map((entry) => Buffer.byteLength(entry.variant)));
  const characters = tableOf(table);
  const text = (input: string): string => scrubText(characters, input);
  const raw = byteTable(table);
  const bytes = (input: Buffer): Buffer =>
    Buffer.from(scrubText(raw, input.toString('latin1')), 'latin1');
  const binary = (value: Uint8Array): string =>
    bytes(Buffer.from(value.buffer, value.byteOffset, value.byteLength)).toString('base64');
  return {
    guardBytes,
    text,
    bytes,
    buffer(input, maxBytes) {
      const scrubbed = bytes(input);
      const isCut = scrubbed.length > maxBytes;
      return {
        text: (isCut ? scrubbed.subarray(0, maxBytes) : scrubbed).toString('utf8'),
        truncated: isCut || input.length > maxBytes,
        bytes: input.length,
      };
    },
    base64(input, maxBytes) {
      const scrubbed = bytes(input);
      const fit = scrubbed.subarray(0, base64Room(maxBytes));
      return {
        text: fit.toString('base64'),
        truncated: fit.length < scrubbed.length || input.length > maxBytes,
        bytes: input.length,
      };
    },
    deep: <T>(value: T): T => scrubDeep(value, { text, binary }) as T,
  };
}
