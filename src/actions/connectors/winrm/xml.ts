/**
 * The strict reader for WS-Management responses (T33). It is not an XML
 * parser: it reads the one document shape the five SOAP operations answer
 * with — elements, attributes in quotes, and text — and refuses everything
 * else outright. There is no DOCTYPE, no entity of any kind (not even a
 * predefined one: every value this connector reads is a UUID, a URI, an
 * integer or base64, so an `&` in one of them is a malformed response), no
 * comment, no CDATA section and no processing instruction beyond the leading
 * XML declaration. Depth, element count and attribute count are capped, so a
 * hostile destination cannot make the reader work harder than the document
 * it sent.
 */
const MAX_DEPTH = 24;
const MAX_ELEMENTS = 4096;
const MAX_ATTRIBUTES = 32;

const NAME_START = /[A-Za-z_]/u;
const NAME_REST = /[\w.:-]/u;

export class XmlProblem extends Error {
  constructor(reason: string) {
    super(`the response is not readable XML: ${reason}`);
    this.name = 'XmlProblem';
  }
}

export interface XmlElement {
  /**
  The name as written, prefix and all (`rsp:Stream`).
  */
  readonly name: string;
  /**
  The part after the prefix (`Stream`); WS-Management answers name their elements consistently,
  and the prefix a destination chooses is its own business.
  */
  readonly local: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string;
  readonly children: readonly XmlElement[];
}

class Reader {
  readonly #text: string;
  #at = 0;
  #elements = 0;

  constructor(text: string) {
    this.#text = text;
  }

  #fail(reason: string): never {
    throw new XmlProblem(reason);
  }

  #peek(prefix: string): boolean {
    return this.#text.startsWith(prefix, this.#at);
  }

  #take(prefix: string): void {
    if (!this.#peek(prefix)) {
      this.#fail(`expected ${prefix}`);
    }
    this.#at += prefix.length;
  }

  #skipSpace(): void {
    while (/\s/u.test(this.#text.charAt(this.#at))) {
      this.#at += 1;
    }
  }

  #name(): string {
    const start = this.#at;
    if (!NAME_START.test(this.#text.charAt(this.#at))) {
      this.#fail('expected an element or attribute name');
    }
    this.#at += 1;
    while (NAME_REST.test(this.#text.charAt(this.#at))) {
      this.#at += 1;
    }
    return this.#text.slice(start, this.#at);
  }

  /**
  A quoted attribute value; an `&` in it is a reference this reader will not evaluate.
  */
  #value(): string {
    const quote = this.#text.charAt(this.#at);
    if (quote !== '"' && quote !== "'") {
      this.#fail('expected a quoted attribute value');
    }
    this.#at += 1;
    const end = this.#text.indexOf(quote, this.#at);
    if (end === -1) {
      this.#fail('an attribute value is not closed');
    }
    const value = this.#text.slice(this.#at, end);
    if (value.includes('&') || value.includes('<')) {
      this.#fail('an attribute value contains a reference or a tag');
    }
    this.#at = end + 1;
    return value;
  }

  /**
  The attributes of an open tag, and whether the tag closed itself.
  */
  #attributes(): { attributes: Record<string, string>; isEmpty: boolean } {
    const attributes: Record<string, string> = {};
    for (let count = 0; count <= MAX_ATTRIBUTES; count += 1) {
      this.#skipSpace();
      if (this.#peek('/>')) {
        this.#at += 2;
        return { attributes, isEmpty: true };
      }
      if (this.#peek('>')) {
        this.#at += 1;
        return { attributes, isEmpty: false };
      }
      const name = this.#name();
      this.#skipSpace();
      this.#take('=');
      this.#skipSpace();
      attributes[name] = this.#value();
    }
    this.#fail('an element carries more attributes than any WS-Management response does');
  }

  /**
  The character data up to the next tag; a reference is refused rather than evaluated.
  */
  #characters(): string {
    const next = this.#text.indexOf('<', this.#at);
    if (next === -1) {
      this.#fail('an element is not closed');
    }
    const text = this.#text.slice(this.#at, next);
    if (text.includes('&')) {
      this.#fail('character data contains a reference');
    }
    this.#at = next;
    return text;
  }

  #element(depth: number): XmlElement {
    if (depth > MAX_DEPTH) {
      this.#fail('the document is nested deeper than any WS-Management response is');
    }
    this.#elements += 1;
    if (this.#elements > MAX_ELEMENTS) {
      this.#fail('the document holds more elements than any WS-Management response does');
    }
    this.#take('<');
    const name = this.#name();
    const { attributes, isEmpty } = this.#attributes();
    const element = { name, local: localName(name), attributes };
    return isEmpty
      ? { ...element, text: '', children: [] }
      : { ...element, ...this.#content(name, depth) };
  }

  /**
  Everything between an open tag and its matching close tag.
  */
  #content(name: string, depth: number): { text: string; children: XmlElement[] } {
    const children: XmlElement[] = [];
    let text = '';
    for (;;) {
      text += this.#characters();
      if (this.#peek('</')) {
        this.#take('</');
        if (this.#name() !== name) {
          this.#fail(`<${name}> is closed by another tag`);
        }
        this.#skipSpace();
        this.#take('>');
        return { text: text.trim(), children };
      }
      if (this.#peek('<!') || this.#peek('<?')) {
        this.#fail('a declaration, comment or section is not accepted here');
      }
      children.push(this.#element(depth + 1));
    }
  }

  /**
  The optional XML declaration; nothing else may precede the root element.
  */
  #declaration(): void {
    this.#skipSpace();
    if (!this.#peek('<?xml')) {
      return;
    }
    const end = this.#text.indexOf('?>', this.#at);
    if (end === -1) {
      this.#fail('the XML declaration is not closed');
    }
    this.#at = end + 2;
    this.#skipSpace();
  }

  document(): XmlElement {
    this.#declaration();
    const root = this.#element(1);
    this.#skipSpace();
    if (this.#at !== this.#text.length) {
      this.#fail('there is more than one root element');
    }
    return root;
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function parseXml(text: string): XmlElement {
  return new Reader(text).document();
}

/**
The first child with that local name, or `undefined`.
*/
export function child(element: XmlElement, local: string): XmlElement | undefined {
  return element.children.find((candidate) => candidate.local === local);
}

/**
The element at that path of local names, or `undefined` when any step is missing.
*/
export function at(element: XmlElement, ...path: readonly string[]): XmlElement | undefined {
  return path.reduce<XmlElement | undefined>(
    (current, local) => (current === undefined ? undefined : child(current, local)),
    element,
  );
}

/**
Every descendant with that local name, in document order.
*/
export function descendants(element: XmlElement, local: string): readonly XmlElement[] {
  return element.children.flatMap((candidate) => [
    ...(candidate.local === local ? [candidate] : []),
    ...descendants(candidate, local),
  ]);
}
