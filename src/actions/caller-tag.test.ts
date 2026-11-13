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

  it('RELAY-17 ACT-131 a relay token adds the machine name of the node it was issued to', () => {
    const tag = callerTagOf({
      clientName: 'Claude',
      operatorId: 'operator-1',
      tokenId: AUDIT_ID,
      mcpSessionId: undefined,
      relayNode: 'claude-cloud-sandbox-one.example.ts.net',
    });
    expect(tag).toBe('vg:Claude:operator:t=0123456789ab:n=claude-cloud-sandbox-one');
    expect(tag).not.toContain('example');
  });

  it('RELAY-17 ACT-131 a token that is not a relay token has no n= field', () => {
    for (const relayNode of [undefined, '']) {
      expect(
        callerTagOf({
          clientName: 'Claude',
          operatorId: 'operator',
          tokenId: AUDIT_ID,
          mcpSessionId: undefined,
          relayNode,
        }),
      ).toBe('vg:Claude:operator:t=0123456789ab');
    }
  });

  it('RELAY-17 ACT-131 a long node name is cut to the room left under 63 bytes, keeping its end', () => {
    const longest = callerTagOf({
      clientName: 'c'.repeat(40),
      operatorId: 'o'.repeat(40),
      tokenId: AUDIT_ID,
      mcpSessionId: undefined,
      relayNode: `${'claude-cloud-'.repeat(8)}sandbox-ten.example.ts.net`,
    });
    expect(longest).toHaveLength(CALLER_TAG_MAX_BYTES);
    expect(longest).toBe(
      `vg:${'c'.repeat(16)}:${'o'.repeat(8)}:t=0123456789ab:n=cloud-sandbox-ten`,
    );
    const withSession = callerTagOf({
      clientName: 'c'.repeat(40),
      operatorId: 'o'.repeat(40),
      tokenId: AUDIT_ID,
      mcpSessionId: 'session',
      relayNode: 'claude-cloud-sandbox-ten',
    });
    expect(withSession).toHaveLength(CALLER_TAG_MAX_BYTES);
    expect(withSession).toMatch(/:s=[0-9a-f]{12}:n=en$/u);
    const hostile = callerTagOf({
      clientName: 'Claude',
      operatorId: 'op',
      tokenId: AUDIT_ID,
      mcpSessionId: undefined,
      relayNode: `node "x"; DROP\u{0}\n${'\u{C4}'.repeat(3)}-end.example.ts.net`,
    });
    expect(hostile).toMatch(/^[\u{21}-\u{7E}]+$/u);
    expect(hostile).toBe('vg:Claude:op:t=0123456789ab:n=node-x-DROP--end');
    expect(
      callerTagOf({
        clientName: 'Claude',
        operatorId: 'op',
        tokenId: AUDIT_ID,
        mcpSessionId: undefined,
        relayNode: '.example.ts.net',
      }),
    ).toBe('vg:Claude:op:t=0123456789ab:n=unknown');
  });
});
