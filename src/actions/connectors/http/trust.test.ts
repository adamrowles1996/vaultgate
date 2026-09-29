import { describe, expect, it } from 'vitest';

import { certificateDigest } from '../../../net/certificate-pin.ts';
import { TEST_CERTIFICATE_PEM } from '../../../test-support/test-certificate.ts';

import {
  type HttpDestination,
  httpDestinationSchema,
  httpPolicySchema,
  httpSchemas,
} from './schemas.ts';
import { destinationTrust } from './trust.ts';

import type { z } from 'zod';

const DIGEST = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';
const PVE = 'https://pve.example.internal:8006/api2/json';
const PLAIN = 'http://pve.example.internal:8006/api2/json';
const NOT_PEM =
  'destination.ca_pem: is not a PEM certificate; paste it with its line breaks, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----';

function problemsOf(parsed: z.ZodSafeParseResult<unknown>): readonly string[] {
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

/**
The save-time problems of a bearer target on this destination.
*/
function saveProblems(destination: Readonly<Record<string, unknown>>): readonly string[] {
  return httpSchemas.saveProblems({
    destination: httpDestinationSchema.parse(destination),
    credential: { mode: 'bearer', field: 'password' },
    policy: httpPolicySchema.parse({ allowed_paths: ['/**'] }),
  });
}

describe('the http destination’s private trust', () => {
  it('ACT-121 ACT-122 names neither by default, which leaves the system store in charge', () => {
    expect(httpDestinationSchema.parse({ base_url: PVE })).toStrictEqual({ base_url: PVE });
    expect(saveProblems({ base_url: PVE })).toStrictEqual([]);
    expect(destinationTrust({ base_url: PVE })).toStrictEqual({});
  });

  it('ACT-121 accepts a pin with or without colons and spaces, in either case, and stores it lower-case without them', () => {
    const colons = DIGEST.toUpperCase().replaceAll(/(.{2})(?=.)/gu, '$1:');
    const spaced = DIGEST.replaceAll(/(.{8})(?=.)/gu, '$1 ');
    for (const written of [colons, spaced, DIGEST]) {
      expect(
        httpDestinationSchema.parse({ base_url: PVE, certificate_sha256: written }),
      ).toStrictEqual({ base_url: PVE, certificate_sha256: DIGEST });
    }
  });

  it('ACT-121 refuses a pin that is not a SHA-256 fingerprint', () => {
    for (const certificate_sha256 of ['abc', `${DIGEST}00`, 'zz'.repeat(32), '']) {
      expect(
        problemsOf(httpDestinationSchema.safeParse({ base_url: PVE, certificate_sha256 })),
      ).toStrictEqual(['must be a SHA-256 fingerprint: 64 hexadecimal digits, colons optional']);
    }
  });

  it('ACT-122 accepts one or more PEM certificates and refuses an empty authority', () => {
    const two = `${TEST_CERTIFICATE_PEM}\n${TEST_CERTIFICATE_PEM}\n`;
    for (const ca_pem of [TEST_CERTIFICATE_PEM, two]) {
      expect(httpDestinationSchema.parse({ base_url: PVE, ca_pem })).toStrictEqual({
        base_url: PVE,
        ca_pem,
      });
      expect(saveProblems({ base_url: PVE, ca_pem })).toStrictEqual([]);
    }
    expect(httpDestinationSchema.safeParse({ base_url: PVE, ca_pem: '' }).success).toBe(false);
  });

  it('ACT-122 refuses at save an authority that is not PEM certificates, as a one-line paste is', () => {
    const lines = TEST_CERTIFICATE_PEM.split('\n');
    const oneLine = lines.join('');
    const damaged = [...lines.slice(0, 2), ...lines.slice(3)].join('\n');
    const followedByJunk = `${TEST_CERTIFICATE_PEM}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----`;
    for (const ca_pem of ['-----BEGIN', oneLine, damaged, followedByJunk]) {
      expect(saveProblems({ base_url: PVE, ca_pem })).toStrictEqual([NOT_PEM]);
    }
  });

  it('ACT-121 ACT-122 refuses at save a pin and an authority together, and either on an http:// base_url, reporting every problem at once', () => {
    const both =
      'destination.certificate_sha256: give a certificate pin or a certificate authority, not both';
    const pinOnPlain =
      'destination.certificate_sha256: a certificate pin needs an https:// base_url';
    const caOnPlain = 'destination.ca_pem: a certificate authority needs an https:// base_url';
    expect(
      saveProblems({ base_url: PVE, certificate_sha256: DIGEST, ca_pem: TEST_CERTIFICATE_PEM }),
    ).toStrictEqual([both]);
    expect(saveProblems({ base_url: PLAIN, certificate_sha256: DIGEST })).toStrictEqual([
      pinOnPlain,
    ]);
    expect(saveProblems({ base_url: PLAIN, ca_pem: TEST_CERTIFICATE_PEM })).toStrictEqual([
      caOnPlain,
    ]);
    expect(
      saveProblems({ base_url: PLAIN, certificate_sha256: DIGEST, ca_pem: '-----BEGIN' }),
    ).toStrictEqual([both, pinOnPlain, caOnPlain, NOT_PEM]);
    expect(saveProblems({ base_url: PLAIN })).toStrictEqual([]);
  });
});

describe('destinationTrust', () => {
  const LEAF = Buffer.from('canary-leaf-certificate-der', 'utf8');

  it('ACT-121 turns a pin into the transport’s certificate check, which accepts that certificate only', () => {
    const destination: HttpDestination = {
      base_url: PVE,
      certificate_sha256: certificateDigest(LEAF),
    };
    const trust = destinationTrust(destination);
    expect(Object.keys(trust)).toStrictEqual(['certificate']);
    expect(trust.certificate?.(LEAF)).toBeUndefined();
    expect(trust.certificate?.(Buffer.from('another', 'utf8'))).toMatchObject({
      code: 'ERR_TLS_CERT_PIN_MISMATCH',
    });
  });

  it('ACT-122 hands a private authority to the transport as it was written', () => {
    expect(destinationTrust({ base_url: PVE, ca_pem: TEST_CERTIFICATE_PEM })).toStrictEqual({
      ca: TEST_CERTIFICATE_PEM,
    });
  });
});
