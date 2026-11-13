/**
 * The caller tag (ACT-131): one short, printable line naming who made a call,
 * built from what reaches vaultgate on the `tools/call` request and never from
 * a credential. A `sql` call hands it to the database (ACT-132) and the
 * `action_calls` row keeps it (ACT-133), so a write found in a database can be
 * matched to the call, and the call to the agent, without reading timestamps.
 *
 * `vg:<client>:<operator>:t=<token id>[:s=<session>][:n=<node>]`
 *
 * - `client` is the OAuth client's registered name, reduced to `[A-Za-z0-9._-]`;
 * - `operator` is the OAuth subject, the operator who approved the consent;
 * - `t=` is the MCP-13 token id (the first 12 hex characters of the token's
 *   SHA-256, already in every audit row), which tells apart two sessions of
 *   one client that hold different tokens;
 * - `s=` is the first 12 hex characters of the SHA-256 of the
 *   `Mcp-Session-Id` header, the most specific identifier, present only when
 *   the client sends one;
 * - `n=` is the machine name of the tailnet node a relay token was issued to
 *   (RELAY-17), which names the sandbox, and so the session, behind the call.
 *   It is absent on every token the token endpoint issues. It fills what room
 *   is left under the 63-byte bound, keeping the end of the name, where a
 *   sandbox's own suffix sits, when it does not all fit.
 */
import { createHash } from 'node:crypto';

/**
What the tag is built from; every part is already safe to audit.
*/
export interface CallerTagParts {
  readonly clientName: string;
  readonly operatorId: string;
  /**
  MCP-13: the token id, never the token.
  */
  readonly tokenId: string;
  /**
  The raw `Mcp-Session-Id` header, hashed here and never used as it is.
  */
  readonly mcpSessionId: string | undefined;
  /**
  RELAY-17: the node a relay token was issued to, its MagicDNS name as the relay admitted it.
  */
  readonly relayNode?: string | undefined;
}

/**
ACT-131: PostgreSQL keeps 63 bytes of `application_name`; the tag never needs cutting.
*/
export const CALLER_TAG_MAX_BYTES = 63;

const CLIENT_CHARACTERS = 16;
const OPERATOR_CHARACTERS = 8;
const HASH_CHARACTERS = 12;
const TOKEN_ID = /^[0-9a-f]{12}$/;
const UNSAFE = /[^\w.-]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const LEADING_DASHES = /^-+/;
const FIRST_DOT_ONWARDS = /\..*$/su;
const NODE_FIELD = ':n=';

/**
Printable ASCII the database shows as written: anything else becomes `-`, and the result is cut.
*/
function safePart(text: string, characters: number): string {
  const cleaned = text.replaceAll(UNSAFE, '-').replaceAll(EDGE_DASHES, '').slice(0, characters);
  return cleaned === '' ? 'unknown' : cleaned;
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_CHARACTERS);
}

/**
 * ACT-131 RELAY-17: `:n=<node>` in the `room` bytes the rest of the tag
 * leaves, or nothing for a token that is not a relay token. Only the machine
 * name, the first label of the MagicDNS name, is used; when it is longer than
 * the room, its end is kept, because that is where a sandbox's own suffix sits.
 * The rest of the tag is at most 58 bytes, so the node always keeps at least
 * two characters.
 */
function nodeField(relayNode: string | undefined, room: number): string {
  if (relayNode === undefined || relayNode === '') {
    return '';
  }
  const machine = safePart(relayNode.replace(FIRST_DOT_ONWARDS, ''), Number.MAX_SAFE_INTEGER);
  const kept = machine.slice(-(room - NODE_FIELD.length)).replace(LEADING_DASHES, '');
  return `${NODE_FIELD}${kept}`;
}

/**
 * ACT-131: the tag for one call. A token id that is not the MCP-13 shape is
 * hashed again rather than trusted, so nothing longer than an audit id can
 * reach the database through it.
 */
export function callerTagOf(parts: CallerTagParts): string {
  const tokenId = TOKEN_ID.test(parts.tokenId) ? parts.tokenId : shortHash(parts.tokenId);
  const session =
    parts.mcpSessionId === undefined || parts.mcpSessionId === ''
      ? ''
      : `:s=${shortHash(parts.mcpSessionId)}`;
  const client = safePart(parts.clientName, CLIENT_CHARACTERS);
  const operator = safePart(parts.operatorId, OPERATOR_CHARACTERS);
  // ASCII by construction, so characters are bytes; the parts already fit, and this keeps it so.
  const tag = `vg:${client}:${operator}:t=${tokenId}${session}`.slice(0, CALLER_TAG_MAX_BYTES);
  return `${tag}${nodeField(parts.relayNode, CALLER_TAG_MAX_BYTES - tag.length)}`.slice(
    0,
    CALLER_TAG_MAX_BYTES,
  );
}
