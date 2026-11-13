import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CALLER_TAG_MAX_BYTES, callerTagOf } from './caller-tag.ts';

const AUDIT_ID = '0123456789ab';

function sha12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

describe('the caller tag', () => {
  it('ACT-131 names the client, the operator and the token id when no session id reaches vaultgate', () => {
    expect(
      callerTagOf({
        clientName: 'Claude Code',
        operatorId: 'op_7f3a9c2e41d0',
        tokenId: AUDIT_ID,
        mcpSessionId: undefined,
      }),
    ).toBe('vg:Claude-Code:op_7f3a9:t=0123456789ab');
  });

  it('ACT-131 adds the hash of the MCP session id, never the id itself, when the client sends one', () => {
    const tag = callerTagOf({
      clientName: 'Claude',
      operatorId: 'operator-1',
      tokenId: AUDIT_ID,
      mcpSessionId: 'session-7d1c-raw',
    });
    expect(tag).toBe(`vg:Claude:operator:t=0123456789ab:s=${sha12('session-7d1c-raw')}`);
    expect(tag).not.toContain('session-7d1c-raw');
    expect(
      callerTagOf({ clientName: 'Claude', operatorId: 'o', tokenId: AUDIT_ID, mcpSessionId: '' }),
    ).toBe('vg:Claude:o:t=0123456789ab');
  });

  it('ACT-131 stays printable ASCII of at most 63 bytes whatever the client calls itself', () => {
    const tag = callerTagOf({
      clientName: `  \u{C4}gent "one"; DROP TABLE x -- ${'z'.repeat(200)}`,
      operatorId: '../../../\u{0}\nroot',
      tokenId: AUDIT_ID,
      mcpSessionId: 'x'.repeat(500),
    });
    expect(Buffer.byteLength(tag, 'utf8')).toBeLessThanOrEqual(CALLER_TAG_MAX_BYTES);
    expect(tag).toMatch(/^[\u{21}-\u{7E}]+$/u);
    expect(tag).toMatch(/^vg:gent-one-DROP-TA:\.\.-\.\.-\.\.:t=0123456789ab:s=[0-9a-f]{12}$/u);
    expect(
      callerTagOf({ clientName: '', operatorId: '', tokenId: AUDIT_ID, mcpSessionId: undefined }),
    ).toBe('vg:unknown:unknown:t=0123456789ab');
  });

  it('ACT-131 (iv) a token id that is not the MCP-13 shape is hashed again, so a token cannot pass through it', () => {
    const token = 'vg_at_not-an-id-but-the-token-itself';
    const tag = callerTagOf({
      clientName: 'Agent',
      operatorId: 'op',
      tokenId: token,
      mcpSessionId: undefined,
    });
    expect(tag).toBe(`vg:Agent:op:t=${sha12(token)}`);
    expect(tag).not.toContain(token);
    expect(tag).not.toContain('vg_at_');
  });
});
