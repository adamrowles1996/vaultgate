/**
 * Request builders and page parsers shared by the OAuth tests.
 */
import type { Exchange, OAuthHarness, SignedIn } from './oauth-harness.ts';

export function formBody(
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

export function jsonBody(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/**
 * Prettier lays `html` templates out over many lines; comparisons ignore the
 * whitespace between tags and collapse the rest to one space.
 */
export function flattenHtml(markup: string): string {
  return markup
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/>\s+</g, '><')
    .replaceAll(/\s+</g, '<')
    .replaceAll(/>\s+/g, '>')
    .trim();
}

export function parseJson(exchange: Exchange): Record<string, unknown> {
  return JSON.parse(exchange.text) as Record<string, unknown>;
}

export interface ConsentForm {
  readonly requestId: string;
  readonly csrfToken: string;
  readonly html: string;
}

export function parseConsentForm(html: string): ConsentForm {
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrfToken = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { requestId, csrfToken, html };
}

export function cimdDocument(clientId: string, redirectUris: readonly string[]): () => Response {
  return () =>
    Response.json(
      { client_id: clientId, client_name: 'CIMD Agent', redirect_uris: redirectUris },
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      },
    );
}

/**
 * Drives the browser half of the authorization flow (spec §02.3.1 steps 4–6)
 * for a signed-in operator and yields the consent form ready to post.
 */
export async function openConsent(
  harness: OAuthHarness,
  signedIn: SignedIn,
  parameters: Readonly<Record<string, string>>,
): Promise<ConsentForm> {
  const search = new URLSearchParams(parameters).toString();
  const started = await harness.exchange(`/oauth/authorize?${search}`, {
    headers: signedIn.headers,
  });
  const path = started.headers.get('location') ?? '';
  const page = await harness.exchange(path, { headers: signedIn.headers });
  return parseConsentForm(page.text);
}
