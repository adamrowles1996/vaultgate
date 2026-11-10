/**
 * Which custom-field values look like they carry a secret, whatever the field's name (MCP-18).
 *
 * A field named "Custom Field 1" can still hold a connection string with a password in it, so the
 * name alone is not enough. A value is secret-looking when it embeds a credential in one of the
 * shapes people paste into text fields: a `key=value` or `key: value` pair (ADO.NET, ODBC, JDBC,
 * PostgreSQL keyword strings, Azure storage, service-bus and SAS strings, URL query strings,
 * JSON, HTTP headers) with a secret-looking key and a non-empty value, an address with a password
 * in it (`scheme://user:password@host`, `user:password@host`, `user/password@host`), or a PEM
 * private key. Every pattern is bounded, so the scan stays linear in the length of the value.
 */
import { isSecretLookingName, nameWords } from './secret-names.ts';

/**
Values longer than this are withheld unread: no credential-free metadata needs one, and it bounds
the work a planted value can cause.
*/
const MAX_SCANNED_LENGTH = 8192;

/**
A key (a letter, then up to 40 word characters, spaces, dots or hyphens, taken as short as
possible), an optional closing quote, `=` or `:`, then a quoted, braced or bare value; a bare
value (whose first character may be anything but a space, `;`, `&` or `,`) stops at a space or
at `;`, `&`, `?` or `,`, so a URL never swallows its query.
*/
const KEY_VALUE_PAIR =
  /([a-z][\w .-]{0,40}?)["']?\s{0,8}[=:]\s{0,8}("[^"]{0,512}"|'[^']{0,512}'|\{[^}]{0,512}\}|[^\s;&,][^\s;&?,"'}]{0,511})/gi;

/**
An address carrying a password: `scheme://user:password@host`, where the user may be empty and
the password may hold `;`, `=` and `,` as RFC 3986 allows, or a
bare `user:password@host` or `user/password@host` that starts the value or follows a space, `:`,
`;`, `=` or `,` (so a URL path is never read as a user). Each branch has an anchored start and
bounded parts, so no start position is retried from inside another.
*/
const ADDRESS_WITH_PASSWORD =
  /(?:(?<![a-z\d+.-])[a-z][a-z\d+.-]{0,31}:\/\/[^\s/@:;=,]{0,128}:[^\s/@]{1,256}|(?<![^\s:;=,])[^\s/@:;=,]{1,128}[:/][^\s/@:;=,]{1,256})@[a-z\d[]/i;

/**
The `BEGIN … PRIVATE KEY` armour line of a pasted PEM private key, OpenSSH and PKCS#8 alike.
*/
const PEM_PRIVATE_KEY = /-{5}BEGIN [A-Z ]{0,40}PRIVATE KEY-{5}/;

/**
Words that mark a pair's key as secret on top of the name rule: they sit in connection, SAS and
header strings (`Pass=`, `sig=`, `?code=`, `Authorization: Bearer …`) but are too common to
withhold as field names.
*/
const VALUE_KEY_WORDS: ReadonlySet<string> = new Set([
  'pass',
  'sig',
  'signature',
  'sas',
  'auth',
  'authorization',
  'bearer',
  'code',
]);

/**
Characters that only wrap a value, as ODBC writes `PWD={x}` and others quote it.
*/
const VALUE_WRAPPING = /^["'{]+|["'}]+$/g;

function isSecretKey(key: string): boolean {
  return isSecretLookingName(key) || nameWords(key).some((word) => VALUE_KEY_WORDS.has(word));
}

function hasSecretPair(value: string): boolean {
  for (const [, key = '', raw = ''] of value.matchAll(KEY_VALUE_PAIR)) {
    if (raw.replaceAll(VALUE_WRAPPING, '').trim().length > 0 && isSecretKey(key)) {
      return true;
    }
  }
  return false;
}

/**
True when a text value embeds a credential: a secret-looking pair, an address with a password or
a PEM private key.
*/
export function isSecretLookingValue(value: string): boolean {
  return (
    value.length > MAX_SCANNED_LENGTH ||
    ADDRESS_WITH_PASSWORD.test(value) ||
    PEM_PRIVATE_KEY.test(value) ||
    hasSecretPair(value)
  );
}
