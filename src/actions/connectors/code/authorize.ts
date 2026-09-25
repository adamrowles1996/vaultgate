/**
 * The `code` connector's policy decisions (ACT-110): pure, no I/O (ACT-78).
 * Every call is a read. A per-call `ref` needs `allow_ref`, a single content
 * type must be one the policy allows, `top_k` may not pass `max_top_k`, and
 * `code_read` needs `allow_read`. The description names the query, the path
 * and the line for the audit trail (ACT-116).
 */
import {
  type CodeCredential,
  type CodeDestination,
  normaliseContent,
  type CodePolicy,
  type ContentType,
} from './schemas.ts';
import {
  CODE_FIND_RELATED,
  CODE_READ,
  type CodeOperation,
  type ContentSelection,
  type ReadOperation,
  type RelatedOperation,
  type SearchOperation,
} from './tools.ts';

import type { PolicyDecision } from '../../policy.ts';
import type { OperationDescription, OperationRequest } from '../connector.ts';

type CodeRequest = OperationRequest<CodeDestination, CodeCredential, CodePolicy>;

export function isRead(tool: string, operation: CodeOperation): operation is ReadOperation {
  return tool === CODE_READ && !('query' in operation) && !('line' in operation);
}

export function isRelated(tool: string, operation: CodeOperation): operation is RelatedOperation {
  return tool === CODE_FIND_RELATED && 'line' in operation;
}

export function isSearch(operation: CodeOperation): operation is SearchOperation {
  return 'query' in operation;
}

/**
The content types one call asks for under one policy, or `undefined` when the policy refuses it.
*/
export function selectedContent(
  policy: Pick<CodePolicy, 'content'>,
  selection: ContentSelection | undefined,
): readonly ContentType[] | undefined {
  if (selection === undefined || selection === 'all') {
    return normaliseContent(policy.content);
  }
  return policy.content.includes(selection) ? [selection] : undefined;
}

function contentOf(operation: CodeOperation): ContentSelection | undefined {
  return 'content' in operation ? operation.content : undefined;
}

function topKOf(operation: CodeOperation): number | undefined {
  return 'top_k' in operation ? operation.top_k : undefined;
}

export function authorizeCode(request: CodeRequest, operation: CodeOperation): PolicyDecision {
  const { policy } = request;
  if (request.tool === CODE_READ && !policy.allow_read) {
    return { allowed: false, reason: 'read' };
  }
  if (operation.ref !== undefined && !policy.allow_ref) {
    return { allowed: false, reason: 'ref' };
  }
  if (selectedContent(policy, contentOf(operation)) === undefined) {
    return { allowed: false, reason: 'content' };
  }
  const topK = topKOf(operation);
  return topK !== undefined && topK > policy.max_top_k
    ? { allowed: false, reason: 'top_k' }
    : { allowed: true, operation: 'read' };
}

/**
ACT-116: `search`, `related` or `read`, with what the agent asked for.
*/
export function describeCode(request: CodeRequest, operation: CodeOperation): OperationDescription {
  if (isSearch(operation)) {
    // A query is at most 1 000 characters (ACT-110), under ACT-43's cap, so it is shown whole.
    return { summary: `search ${operation.query}`, classification: 'search' };
  }
  if (isRelated(request.tool, operation)) {
    return {
      summary: `related ${operation.file_path}:${String(operation.line)}`,
      classification: 'related',
    };
  }
  return { summary: `read ${operation.file_path}`, classification: 'read' };
}
