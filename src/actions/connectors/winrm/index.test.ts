import { describe, expect, it } from 'vitest';

import { fakeWsman } from '../../../test-support/fake-wsman.ts';
import { winrmSessionOverFake } from '../../../test-support/winrm-connector.ts';
import { ActionError } from '../../errors.ts';

import { read } from './client.ts';
import { cleanupSignal, createWinrmConnector } from './index.ts';
import { WINRM_RUN_TOOL } from './operation.ts';
import { XmlProblem } from './xml.ts';

describe('createWinrmConnector', () => {
  it('§14.6 serves winrm_run over the winrm schemas', () => {
    const connector = createWinrmConnector(
      { allowAnyCommand: false },
      winrmSessionOverFake(fakeWsman()),
    );
    expect(connector.kind).toBe('winrm');
    expect(connector.tools.map((tool) => tool.name)).toStrictEqual([WINRM_RUN_TOOL]);
  });

  it('ACT-90 gives the shell teardown a deadline that has not already passed', () => {
    const signal = cleanupSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});

describe('read', () => {
  it('T33 turns a refused response into upstream_error and leaves any other failure alone', () => {
    expect(() =>
      read(() => {
        throw new XmlProblem('nope');
      }),
    ).toThrow(ActionError);
    const bug = new TypeError('a fault of our own');
    expect(() =>
      read(() => {
        throw bug;
      }),
    ).toThrow(bug);
  });
});
