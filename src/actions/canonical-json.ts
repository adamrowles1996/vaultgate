/**
 * Canonical JSON: object keys sorted at every level, arrays in order, the
 * standard scalar serialisation, `undefined` properties dropped. Two values
 * that mean the same document serialise to the same text, so comparing the
 * text is comparing the documents (ACT-7's changed fields).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
