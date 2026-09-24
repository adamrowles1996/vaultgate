/**
 * The `RunSupport` a connector contract test runs against: the real secret
 * holder, so a captured value really does join the scrub table (ACT-51), and
 * a record of every host resolved, secret captured and credential rotated,
 * so a test asserts what the connector asked the engine to do without an
 * engine, a vault or a resolver.
 */
import { createSecretHolder, type SecretHolder } from '../actions/secrets.ts';
import { fail, ok, type Result } from '../result.ts';

import type {
  CallTarget,
  Endpoint,
  PinnedEndpoint,
  RunSupport,
} from '../actions/connectors/connector.ts';
import type { ActionError } from '../actions/errors.ts';
import type { InjectedEntry } from '../actions/scrub.ts';

export const SUPPORT_ADDRESS = '20.190.190.1';

export interface Rotation {
  readonly field: string;
  readonly value: string;
}

export interface RecordedSupport {
  readonly support: RunSupport;
  readonly secrets: SecretHolder;
  readonly resolved: string[];
  readonly captured: Rotation[];
  readonly rotations: Rotation[];
}

export interface SupportOptions {
  readonly entries?: readonly InjectedEntry[];
  readonly username?: string | undefined;
  readonly target?: Partial<CallTarget>;
  /**
  The address every `resolve` answers with, or the error it fails with.
  */
  readonly address?: string;
  readonly resolution?: ActionError;
  /**
  Makes every `rotate` fail, as a vault that refuses the write does (ACT-83).
  */
  readonly rotation?: ActionError;
}

const DEFAULT_TARGET: CallTarget = { id: 'target-1', name: 'graph', revision: 1 };

export function recordedSupport(options: SupportOptions = {}): RecordedSupport {
  const secrets = createSecretHolder(options.entries ?? [], options.username);
  const resolved: string[] = [];
  const captured: Rotation[] = [];
  const rotations: Rotation[] = [];
  const target = { ...DEFAULT_TARGET, ...options.target };
  const support: RunSupport = {
    target,
    resolve: (endpoint: Endpoint): Promise<Result<PinnedEndpoint, ActionError>> => {
      resolved.push(endpoint.host);
      return Promise.resolve(
        options.resolution === undefined
          ? ok({ ...endpoint, address: options.address ?? SUPPORT_ADDRESS })
          : fail(options.resolution),
      );
    },
    capture: (field, value) => {
      captured.push({ field, value: value.toString('utf8') });
      secrets.add({ field, value });
    },
    rotate: (field, value) => {
      rotations.push({ field, value });
      return Promise.resolve(
        options.rotation === undefined ? ok(undefined) : fail(options.rotation),
      );
    },
    scrub: (text) => secrets.scrub.text(text),
  };
  return { support, secrets, resolved, captured, rotations };
}
