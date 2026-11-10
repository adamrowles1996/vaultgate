/**
 * Which custom-field names look like they hold a secret (MCP-18).
 *
 * A text custom field is readable by design, but people store secrets in them
 * anyway: a field named "Secret Value" or "API Key" created as text rather than
 * hidden. The metadata tools withhold the value of any text field whose name
 * matches here, so they can never print it; `get_secret` still reads it, audited.
 */

/**
Matched anywhere in the name once case and every non-alphanumeric character are dropped, so
"Client Secret", "client_secret" and "clientSecret" all read as `clientsecret`.
*/
const SECRET_FRAGMENTS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'pwd',
  'token',
  'apikey',
  'private',
  'credential',
  'connectionstring',
];

/**
Matched only as a whole word of the name, because as fragments they sit inside ordinary names:
"key" in "monkey", "pat" in "path", "conn" in "connector".
*/
const SECRET_WORDS: ReadonlySet<string> = new Set(['key', 'keys', 'pat', 'pats', 'conn']);

const CAMEL_BOUNDARY = /([a-z\d])([A-Z])/g;
const NON_ALPHANUMERIC = /[^a-z\d]+/;

function words(name: string): string[] {
  return name
    .replaceAll(CAMEL_BOUNDARY, '$1 $2')
    .toLowerCase()
    .split(NON_ALPHANUMERIC)
    .filter((word) => word.length > 0);
}

/**
True when a custom field called `name` looks like it holds a secret.
*/
export function isSecretLookingName(name: string): boolean {
  const parts = words(name);
  const compact = parts.join('');
  return (
    SECRET_FRAGMENTS.some((fragment) => compact.includes(fragment)) ||
    parts.some((word) => SECRET_WORDS.has(word))
  );
}
