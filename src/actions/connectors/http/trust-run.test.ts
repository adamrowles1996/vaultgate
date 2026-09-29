// cspell:ignore PVEAPI
import { describe, expect, it } from 'vitest';

import { certificateDigest } from '../../../net/certificate-pin.ts';
import {
  GRAPH_BASE_URL,
  graphCredential,
  graphRequests,
  graphTransport,
  tokenRequests,
  tokenResponse,
} from '../../../test-support/graph.ts';
import {
  coded,
  echoResponse,
  httpConnectorOver,
  httpRunContext,
  redirectResponse as redirect,
  scripted,
  textResponse as text,
  urlsOf,
} from '../../../test-support/http-connector.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { TEST_CERTIFICATE_PEM } from '../../../test-support/test-certificate.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import { httpCredentialSchema, type HttpDestination } from './schemas.ts';

import type { HttpOperation } from './operation.ts';
import type { Result } from '../../../result.ts';
import type { ContextOptions, FakeTransport } from '../../../test-support/http-connector.ts';
import type { ActionError } from '../../errors.ts';
import type { ConnectorOutput } from '../connector.ts';

const LEAF = Buffer.from('canary-leaf-certificate-der', 'utf8');
const OTHER = Buffer.from('canary-other-certificate-der', 'utf8');
const PIN = certificateDigest(LEAF);
const PEM = TEST_CERTIFICATE_PEM;
const FOLLOW = { policy: { follow_redirects: true } };
const GET_VERSION: HttpOperation = { method: 'GET', path: '/version' };

type Trust = Pick<HttpDestination, 'certificate_sha256' | 'ca_pem'>;

/**
One `run` of the real connector over `fake`, on the harness's destination with `trust` added to it.
*/
function runWith(
  fake: FakeTransport,
  trust: Trust,
  options: ContextOptions = {},
  operation: HttpOperation = GET_VERSION,
): Promise<Result<ConnectorOutput, ActionError>> {
  const { context } = httpRunContext(options);
  const destination = { ...context.destination, ...trust };
  return httpConnectorOver(fake).run({ ...context, destination }, operation);
}

function twoHopsThenOk(): FakeTransport {
  return scripted([redirect(302, '/v1/a'), redirect(307, '/v1/b'), text(200, 'ok')]);
}

describe('http_request with a private trust', () => {
  it('ACT-121 gives the pin to the transport on the first request and on every redirect hop it follows', async () => {
    const fake = twoHopsThenOk();
    const outcome = await runWith(fake, { certificate_sha256: PIN }, FOLLOW);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 200 });
    expect(urlsOf(fake)).toStrictEqual([
      'https://api.example.com/v1/version',
      'https://api.example.com/v1/a',
      'https://api.example.com/v1/b',
    ]);
    expect(fake.requests.map((request) => request.certificate?.(LEAF))).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const refused = 'the certificate is not the pinned one';
    expect(fake.requests.map((request) => request.certificate?.(OTHER)?.message)).toStrictEqual([
      refused,
      refused,
      refused,
    ]);
    expect(fake.requests.map((request) => request.ca)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('ACT-122 gives the authority to the transport on the first request and on every redirect hop it follows', async () => {
    const fake = twoHopsThenOk();
    const outcome = await runWith(fake, { ca_pem: PEM }, FOLLOW);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 200 });
    expect(fake.requests.map((request) => request.ca)).toStrictEqual([PEM, PEM, PEM]);
    expect(fake.requests.map((request) => request.certificate)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('ACT-57 ACT-121 ACT-122 a destination that names neither gives the transport no pin and no authority', async () => {
    const fake = twoHopsThenOk();
    await runWith(fake, {}, FOLLOW);
    expect(fake.requests).toHaveLength(3);
    for (const request of fake.requests) {
      expect(request).not.toHaveProperty('certificate');
      expect(request).not.toHaveProperty('ca');
    }
  });

  it('ACT-123 never gives the pin or the authority to the graph token exchange, only to the Graph request', async () => {
    const graph = { baseUrl: GRAPH_BASE_URL, credential: graphCredential() };
    const users: HttpOperation = { method: 'GET', path: '/users' };
    const withAuthority = graphTransport(
      () => tokenResponse(),
      (request) => echoResponse(request),
    );
    unwrapOk(await runWith(withAuthority, { ca_pem: PEM }, graph, users));
    const withPin = graphTransport(
      () => tokenResponse(),
      (request) => echoResponse(request),
    );
    unwrapOk(await runWith(withPin, { certificate_sha256: PIN }, graph, users));
    const tokens = [...tokenRequests(withAuthority), ...tokenRequests(withPin)];
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token.url).toMatch(/^https:\/\/login\.microsoftonline\.com\//u);
      expect(token).not.toHaveProperty('ca');
      expect(token).not.toHaveProperty('certificate');
    }
    expect(graphRequests(withAuthority).map((request) => request.ca)).toStrictEqual([PEM]);
    expect(graphRequests(withPin).map((request) => typeof request.certificate)).toStrictEqual([
      'function',
    ]);
  });

  it('ACT-121 ACT-122 ACT-74 a certificate the pin or the authority refuses is tls_error, naming the code only', async () => {
    const refusals: readonly [Trust, string][] = [
      [{ certificate_sha256: PIN }, 'ERR_TLS_CERT_PIN_MISMATCH'],
      [{ ca_pem: PEM }, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
      [{ ca_pem: PEM }, 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ];
    for (const [trust, code] of refusals) {
      const message = 'Hostname/IP does not match the certificate: IP: 192.0.2.10 is not in it';
      const outcome = await runWith(scripted([coded(message, code)]), trust);
      const failure = unwrapFail(outcome);
      expect(failure).toMatchObject({ code: 'tls_error', detail: { reason: code } });
      expect(JSON.stringify(failure.detail)).not.toContain('192.0.2.10');
    }
  });

  it('ACT-79 ACT-122 sends a Proxmox VE API token in header mode to the cluster API under its own authority', async () => {
    const credential = httpCredentialSchema.parse({
      mode: 'header',
      field: 'password',
      name: 'Authorization',
      prefix: 'PVEAPIToken=vaultgate@pve!agent=',
    });
    const fake = scripted([text(200, '{"data":{"release":"9.0"}}')]);
    const outcome = await runWith(
      fake,
      { ca_pem: PEM },
      {
        baseUrl: 'https://pve.example.internal:8006/api2/json',
        credential,
        pinned: [{ host: 'pve.example.internal', tls: true, address: '192.0.2.10' }],
      },
    );
    expect(unwrapOk(outcome).result).toMatchObject({ status: 200 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: 'https://pve.example.internal:8006/api2/json/version',
      address: '192.0.2.10',
      ca: PEM,
      headers: { authorization: `PVEAPIToken=vaultgate@pve!agent=${CANARY.password}` },
    });
  });
});
