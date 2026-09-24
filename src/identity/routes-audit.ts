import { exportLines, type ExportRequest, parseExportRequest } from '../audit/export-command.ts';
import { FORMATS } from '../audit/format.ts';

import { type IdentityContext, type IdentityEnvironment, readForm } from './browser.ts';
import { auditEvent, requireReauthenticated } from './routes-account.ts';
import { activityResponse } from './routes-console.ts';

import type { IdentityServices } from './services.ts';
import type { Hono } from 'hono';

/**
`2026-09-01T00:00:00.000Z` → `20260901T000000Z`, so the file name has no colons.
*/
function stamp(instant: number): string {
  return new Date(instant).toISOString().replaceAll(/[-:]|\.\d{3}/g, '');
}

function attachment(request: ExportRequest): Record<string, string> {
  const format = FORMATS[request.format];
  const window = `${stamp(request.from)}-${stamp(request.to)}`;
  const name = `vaultgate-${request.stream}-${window}.${format.extension}`;
  return {
    'Content-Type': format.contentType,
    'Content-Disposition': `attachment; filename="${name}"`,
  };
}

/**
 * OPS-5, ACT-62: the export behind the account page form, the audit events
 * or the action calls. Same gate as every other sensitive action (session,
 * synchroniser token, re-authentication within five minutes), then the
 * requested window streams back as a download.
 */
async function exportAudit(context: IdentityContext, services: IdentityServices) {
  const form = await readForm(context);
  const authenticated = requireReauthenticated(context, services, form);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const request = parseExportRequest({
    from: form.get('from'),
    to: form.get('to'),
    format: form.get('format'),
    stream: form.get('stream'),
  });
  if (!request.ok) {
    return activityResponse(context, authenticated.session, services, request.error.message);
  }
  const { from, to, format, stream } = request.value;
  services.audit.record({
    ...auditEvent(context, services, 'audit.exported', authenticated.operator.id),
    details: {
      format,
      stream,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    },
  });
  const lines = exportLines(services.database, request.value);
  return context.body(lines.pipeThrough(new TextEncoderStream()), 200, attachment(request.value));
}

export function registerAuditRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.post('/account/audit/export', (context) => exportAudit(context, services));
}
