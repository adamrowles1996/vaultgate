import { describe, expect, it } from 'vitest';

import { createLoggingAuditSink } from './audit.ts';

describe('createLoggingAuditSink', () => {
  it('MCP-14 writes one structured line per authorization event', () => {
    const lines: unknown[] = [];
    const sink = createLoggingAuditSink({
      info: (fields, message) => {
        lines.push({ ...fields, message });
      },
    });
    sink.record({ category: 'oauth', action: 'token_issued', outcome: 'success', clientId: 'c' });
    expect(lines).toStrictEqual([
      {
        audit: { category: 'oauth', action: 'token_issued', outcome: 'success', clientId: 'c' },
        message: 'authorization event',
      },
    ]);
  });
});
