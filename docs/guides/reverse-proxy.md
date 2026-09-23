# Reverse proxy

vaultgate speaks plain HTTP on a private interface; TLS is always terminated in front of it,
by Caddy in the Compose install or by whatever proxy you run. The proxy must
(spec [DEP-11 and DEP-12](../spec/09-deployment.md)):

- forward `Host` unchanged (or set `X-Forwarded-Host`) and set `X-Forwarded-Proto: https`;
- set `X-Forwarded-For` to the address of the connection it accepted, overwriting whatever the
  client sent rather than appending to it;
- pass the `Authorization` request header and the `WWW-Authenticate` response header through;
- not buffer responses on `/mcp`, which may stream server-sent events, and allow a read
  timeout of at least 60 s.

Set `VAULTGATE_TRUST_PROXY=true` so vaultgate honours the forwarded headers, and only from its
immediate upstream. `VAULTGATE_PUBLIC_URL` must be the `https://` origin the proxy serves; it
becomes the OAuth issuer and the canonical MCP resource.

vaultgate reads the `X-Forwarded-For` entry `VAULTGATE_TRUSTED_PROXY_HOPS` (default `1`) from
the right, the one your proxy wrote, and ignores everything to its left, so a client that sends
its own `X-Forwarded-For` cannot choose the address that rate limits and audit events record.
Raise the number only when a second trusted proxy (a CDN, a load balancer) sits in front of the
first and appends to the header; overwriting at the edge, as the snippets do, keeps the header
honest for your own logs as well.

## Snippets

- [`deploy/proxy/Caddyfile`](../../deploy/proxy/Caddyfile): used verbatim by
  `docker-compose.yml`. For a bare Linux install, replace `vaultgate:8080` with
  `127.0.0.1:8080` and set `VAULTGATE_DOMAIN` in Caddy's environment (or write the hostname in
  its place). Caddy forwards `Host`, sets the `X-Forwarded-*` headers, streams responses and
  applies no read timeout by default; `flush_interval -1` makes the streaming explicit and
  `header_up X-Forwarded-For {remote_host}` makes the overwrite explicit (Caddy already drops
  `X-Forwarded-*` headers from clients it does not trust).
- [`deploy/proxy/nginx.conf`](../../deploy/proxy/nginx.conf): a server block for
  `/etc/nginx/conf.d/`. It sets the forwarding headers (`X-Forwarded-For` from `$remote_addr`,
  not `$proxy_add_x_forwarded_for`, so the client's own header is discarded), disables buffering
  on `/mcp` and sets a 300 s read timeout. Do not add `proxy_hide_header` for `WWW-Authenticate`.

## Checking

```bash
curl -fsS https://vault.example.com/healthz
```

returns `{"status":"ok"}` through the proxy. The start-up log line `configuration loaded`
shows `trustProxy: true` and the public URL vaultgate resolved.
