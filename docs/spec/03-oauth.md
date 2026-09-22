# 03 OAuth 2.1 authorization and resource server

vaultgate implements the MCP authorization specification (2026-07-28) as an
authorization server co-located with the resource server. All identifiers
below are testable requirements.

## 3.1 URLs

| Purpose                          | Path                                                                                    | Notes                                             |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Canonical resource (RFC 8707)    | `${PUBLIC_URL}/mcp`                                                                     | No trailing slash, lower-case scheme and host.    |
| Issuer (RFC 8414)                | `${PUBLIC_URL}`                                                                         | The AS is the origin itself.                      |
| Protected resource metadata      | `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` | Both paths, for path-aware and root-only clients. |
| AS metadata                      | `/.well-known/oauth-authorization-server`                                               |                                                   |
| Authorization endpoint           | `GET /oauth/authorize`, `POST /oauth/authorize`                                         | POST carries the consent decision.                |
| Token endpoint                   | `POST /oauth/token`                                                                     | `application/x-www-form-urlencoded` only.         |
| Revocation endpoint (RFC 7009)   | `POST /oauth/revoke`                                                                    |                                                   |
| Registration endpoint (RFC 7591) | `POST /oauth/register`                                                                  | Deprecated by MCP, kept for compatibility.        |
| MCP endpoint                     | `POST /mcp` (`GET`/`DELETE` per SDK transport)                                          |                                                   |

## 3.2 Metadata documents

- **OAUTH-1** The PRM document MUST contain `resource` (canonical resource), `authorization_servers`
  (`[issuer]`), `scopes_supported` (`["vault:read","vault:reveal","vault:write","vault:generate"]`),
  `bearer_methods_supported: ["header"]` and `resource_documentation`.
- **OAUTH-2** The AS metadata MUST contain `issuer`, `authorization_endpoint`, `token_endpoint`,
  `revocation_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`,
  `grant_types_supported: ["authorization_code","refresh_token"]`,
  `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
  `revocation_endpoint_auth_methods_supported: ["none"]`, `scopes_supported` (the scopes this
  deployment will grant, OAUTH-16, so a client that requests everything advertised succeeds),
  `client_id_metadata_document_supported: true`,
  `authorization_response_iss_parameter_supported: true`.
- **OAUTH-3** Both documents MUST be served with `Content-Type: application/json`,
  `Cache-Control: public, max-age=300`, and permissive CORS (`Access-Control-Allow-Origin: *`) because
  browser-based clients fetch them cross-origin.
- **OAUTH-4** `offline_access` MUST NOT appear in `scopes_supported` or in any `WWW-Authenticate`
  challenge; refresh tokens are issued at the AS's discretion (always, for public clients, in v1).

## 3.3 Client registration

Three mechanisms, resolved in this order when a `client_id` is presented:

1. **Pre-registered** (`VAULTGATE_OAUTH_CLIENTS` JSON): exact `client_id` match.
2. **CIMD**: `client_id` is an `https://` URL with a non-empty path.
3. **DCR**: `client_id` was minted by `POST /oauth/register` and is stored.

- **OAUTH-5** Only public clients are supported. `token_endpoint_auth_method` MUST be `none`;
  registration requests asking for a confidential method are rejected with `invalid_client_metadata`.
- **OAUTH-6** Every `redirect_uri` MUST be `https://…` or a loopback address (`http://localhost`,
  `http://127.0.0.1`, `http://[::1]`, any port). Anything else is rejected at registration and at
  authorize time.
- **OAUTH-7** Redirect URIs are compared by exact string match (after nothing more than the RFC 8252
  loopback port exception, which is applied only to loopback literals).
- **OAUTH-8** CIMD fetches MUST use the SSRF-safe fetcher: `https` only, DNS resolved and checked
  against private/link-local/loopback/multicast ranges before connecting and after each redirect,
  at most 2 redirects, 4 s timeout, 64 KiB body cap, `Accept: application/json`.
- **OAUTH-9** A fetched CIMD MUST have `client_id` exactly equal to the URL, `client_name`,
  `redirect_uris` (non-empty, each passing OAUTH-6). Optional fields are validated when present and
  the document is otherwise passed through untouched.
- **OAUTH-10** CIMD documents are cached honouring `Cache-Control: max-age` bounded to
  [60 s, 24 h] (five minutes when the header is absent); a fetch failure while a cached copy exists
  uses the cached copy and logs a warning. A presented `redirect_uri` the cached document does not
  list forces a refetch before the request is refused (T22).
- **OAUTH-11** DCR is rate limited (10 registrations per IP per hour) and rejects requests larger
  than 16 KiB. `application_type`, `grant_types`, `response_types` and `scope` are validated;
  unknown fields are ignored. The response is `201` with `client_id` (`vg_c_…`), `client_id_issued_at`
  and the echoed metadata; no secret is issued.
- **OAUTH-12** Pre-registered clients are validated at start-up; an invalid list is a fatal
  configuration error.
- **OAUTH-13** The consent page MUST show the client's display name, the full redirect URI host, the
  registration mechanism, and a prominent warning when the redirect is loopback-only (CIMD spec §6).

## 3.4 Authorization endpoint

- **OAUTH-14** Required query parameters: `response_type=code`, `client_id`, `redirect_uri`,
  `code_challenge`, `code_challenge_method=S256`, `resource`, and optionally `scope`, `state`.
  Missing or malformed parameters that prevent identifying a trusted `redirect_uri` are answered
  with an HTML error page, never a redirect (OAuth 2.1 §4.1.2.1).
- **OAUTH-15** `resource` MUST equal the canonical resource; mismatch → `invalid_target`.
- **OAUTH-16** Requested scopes MUST be a subset of `scopes_supported` and of the scopes the
  operator has enabled (`vault:write` is disabled unless `VAULTGATE_ENABLE_WRITE_SCOPE=true`);
  otherwise `invalid_scope`. An empty `scope` defaults to `vault:read`.
- **OAUTH-17** If there is no operator session the request is stored server-side under a random
  `request_id` cookie-bound key and the user is redirected to `/login?next=/oauth/authorize/<id>`;
  parameters are never round-tripped through the login form. The binding is the session when one
  exists, otherwise a `vg_authz` cookie (`__Host-`, `Secure` under https) set on the anonymous
  browser; only that browser can claim the request after logging in. Pending requests expire after
  ten minutes.
- **OAUTH-18** Consent is a `POST` with a synchroniser token; `GET` never issues a code.
  The operator may untick individual scopes; the issued scope set is what was ticked.
- **OAUTH-19** Approval issues a single-use authorization code (`vg_ac_…`, 32 random bytes,
  stored as SHA-256, 5 minute TTL) bound to client, redirect URI, PKCE challenge, resource,
  scopes and operator. The redirect includes `code`, `state` (if given) and `iss`.
- **OAUTH-20** Denial redirects with `error=access_denied`, `state` and `iss`.

## 3.5 Token endpoint

- **OAUTH-21** `grant_type=authorization_code` requires `code`, `client_id`, `redirect_uri`,
  `code_verifier`, `resource`. All five MUST match the stored code; the code MUST be unexpired and
  unused. The check is `UPDATE … WHERE used_at IS NULL` so a race cannot redeem twice.
- **OAUTH-22** Reuse of a consumed code MUST revoke every token issued from it
  (OAuth 2.1 §4.1.3) and return `invalid_grant`.
- **OAUTH-23** PKCE verification uses `base64url(sha256(code_verifier)) === code_challenge` with a
  constant-time comparison.
- **OAUTH-24** Access tokens are opaque (`vg_at_` + 32 random bytes base64url), stored as SHA-256,
  TTL 3600 s. Refresh tokens are `vg_rt_…`, stored as SHA-256, absolute TTL 30 days, single use.
- **OAUTH-25** `grant_type=refresh_token` rotates: the presented refresh token is marked used, a
  new access and refresh token are issued in the same family, `replaced_by` is recorded.
  Presenting an already-used refresh token revokes the whole family (RFC 9700 §4.14) and returns
  `invalid_grant`. Scopes cannot be widened on refresh; a narrower `scope` is honoured.
- **OAUTH-26** The token response is `{access_token, token_type:"Bearer", expires_in, refresh_token,
scope, resource}` with `Cache-Control: no-store`.
- **OAUTH-27** Error responses follow RFC 6749 §5.2 (`invalid_request`, `invalid_client`,
  `invalid_grant`, `unsupported_grant_type`, `invalid_scope`, `invalid_target`) with
  `error_description`; `invalid_client` is answered `401`, the rest `400`, and every error response
  carries `Cache-Control: no-store`. Never include stack traces or internal ids.
- **OAUTH-28** The token endpoint is rate limited (60 requests per IP per minute) and answers
  `429` with `Retry-After`.

## 3.6 Revocation

- **OAUTH-29** `POST /oauth/revoke` accepts `token` and optional `token_type_hint`, always answers
  `200 {}` (RFC 7009 §2.2), and revokes: an access token (itself), a refresh token (its family and
  all access tokens issued from it).
- **OAUTH-30** The operator's account page lists connected clients with last-used time and can
  revoke a client's consent (`POST /oauth/consents/<id>/revoke`, guarded like every account
  action), which revokes all of its tokens.

## 3.7 Resource server behaviour

- **OAUTH-31** Every `/mcp` request MUST carry `Authorization: Bearer …`. Tokens in the query
  string are rejected with `400`.
- **OAUTH-32** Verification: prefix is `vg_at_`, SHA-256 lookup succeeds, not revoked, not expired,
  `resource` equals the canonical resource for this deployment. Any failure → `401` with
  `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…", scope="vault:read"`.
- **OAUTH-33** Insufficient scope → `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="<all scopes the operation needs>",
resource_metadata="…", error_description="…"`, emitted in one challenge, never incrementally.
- **OAUTH-34** vaultgate MUST NOT accept any token it did not issue (no JWTs, no upstream IdP
  tokens) and MUST NOT forward the bearer token anywhere (the `bw serve` session is a separate,
  internal credential).
- **OAUTH-35** Token lookups update `last_used_at` at most once per minute per token to keep the
  hot path cheap.

## 3.8 Scopes

| Scope            | Grants                                                                      | Default enabled                     |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `vault:read`     | Search and list items, folders, collections; item summaries without secrets | yes                                 |
| `vault:reveal`   | `get_secret` (password, TOTP code, secure note body, custom hidden fields)  | yes                                 |
| `vault:generate` | Password and passphrase generation                                          | yes                                 |
| `vault:write`    | Create, update and trash items and folders                                  | no (`VAULTGATE_ENABLE_WRITE_SCOPE`) |

- **OAUTH-36** No scope implies another. The consent page lists each requested scope with a
  one-line human explanation and a risk marker for `vault:reveal` and `vault:write`.

## 3.9 CORS and browser clients

- **OAUTH-37** `/.well-known/*`, `/oauth/token`, `/oauth/revoke`, `/oauth/register` and `/mcp`
  answer `OPTIONS` preflight and set `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version`,
  `Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id`. Cookie-bearing routes
  (`/login`, `/oauth/authorize`, `/account`) never set CORS headers.
