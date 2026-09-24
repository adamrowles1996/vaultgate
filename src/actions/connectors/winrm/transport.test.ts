import { describe, expect, it } from 'vitest';

import { ActionError } from '../../errors.ts';

import { NtlmProblem } from './ntlm/reader.ts';
import { readNtlm } from './transport.ts';

function refuse(): never {
  throw new NtlmProblem('the attribute list never ends');
}

/**
The error `readNtlm` answered with, so the assertions stay out of a catch block.
*/
function failureOf(reader: () => unknown): unknown {
  try {
    reader();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe('readNtlm', () => {
  it('T33 turns a refused NTLM or multipart message into upstream_error', () => {
    const failure = failureOf(() => readNtlm(refuse));
    expect(failure).toBeInstanceOf(ActionError);
    expect(failure instanceof ActionError ? failure.code : '').toBe('upstream_error');
  });

  it('T33 leaves any other failure alone, because it is vaultgate’s own', () => {
    const bug = new TypeError('a fault of our own');
    expect(
      failureOf(() =>
        readNtlm(() => {
          throw bug;
        }),
      ),
    ).toBe(bug);
  });

  it('T33 returns what the reader read when there is nothing to refuse', () => {
    expect(readNtlm(() => 'an envelope')).toBe('an envelope');
  });
});
