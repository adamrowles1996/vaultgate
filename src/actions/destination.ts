/**
 * Destinations and network (spec §13.10): one resolution per call through
 * the injected resolver, every address checked against the private-range
 * rule for the target's `internal` flag (ACT-56), IP literals validated
 * without resolution, and the validated address pinned for the connector
 * (ACT-55). The same check runs at save time (ACT-3).
 */
import { isIP } from 'node:net';

import { classifyAddress, type Lookup } from '../net/ip-ranges.ts';
import { fail, ok, type Result } from '../result.ts';

import type { Endpoint, PinnedEndpoint } from './connectors/connector.ts';

export type DestinationProblem = 'invalid' | 'forbidden' | 'private' | 'unresolved';

const PROBLEM_MESSAGES: Readonly<Record<DestinationProblem, string>> = {
  invalid: 'is not a valid address',
  forbidden: 'is a loopback, link-local, multicast or unspecified address, which is refused always',
  private: 'is a private-range address; set internal: true to allow it',
  unresolved: 'does not resolve to any address',
};

export class DestinationRefusal extends Error {
  readonly problem: DestinationProblem;
  readonly host: string;

  constructor(host: string, problem: DestinationProblem) {
    super(`host "${host}" ${PROBLEM_MESSAGES[problem]}`);
    this.name = 'DestinationRefusal';
    this.problem = problem;
    this.host = host;
  }
}

function literalAddress(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function addressProblem(address: string, isInternal: boolean): DestinationProblem | undefined {
  switch (classifyAddress(address)) {
    case 'public': {
      return undefined;
    }
    case 'private': {
      return isInternal ? undefined : 'private';
    }
    case 'forbidden': {
      return 'forbidden';
    }
    case 'invalid': {
      return 'invalid';
    }
  }
}

async function resolveAll(host: string, lookup: Lookup): Promise<readonly string[]> {
  try {
    return await lookup(host);
  } catch {
    return [];
  }
}

/**
 * Resolves the endpoint's host once and validates every address it maps to;
 * the first address is the one the connector connects to. Loopback,
 * link-local, multicast and unspecified addresses are refused whatever
 * `internal` says; private ranges only when `internal` is `false`.
 */
export async function pinEndpoint(
  endpoint: Endpoint,
  isInternal: boolean,
  lookup: Lookup,
): Promise<Result<PinnedEndpoint, DestinationRefusal>> {
  const literal = literalAddress(endpoint.host);
  const addresses = isIP(literal) === 0 ? await resolveAll(endpoint.host, lookup) : [literal];
  const [first] = addresses;
  if (first === undefined) {
    return fail(new DestinationRefusal(endpoint.host, 'unresolved'));
  }
  for (const address of addresses) {
    const problem = addressProblem(address, isInternal);
    if (problem !== undefined) {
      return fail(new DestinationRefusal(endpoint.host, problem));
    }
  }
  return ok({ ...endpoint, address: first });
}
