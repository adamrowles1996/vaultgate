import { type ExportRequest, parseExportRequest } from '../audit/export-command.ts';
import { FORMATS } from '../audit/format.ts';
import { exportAuditEvents } from '../audit/query.ts';

import { type IdentityContext, type IdentityEnvironment, readForm } from './browser.ts';
import { renderAccount } from './pages/account.ts';
import { accountView, auditEvent, requireReauthenticated } from './routes-account.ts';

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
  const name = `vaultgate-audit-${stamp(request.from)}-${stamp(request.to)}.${format.extension}`;
  return {
    'Content-Type': format.contentType,
    'Content-Disposition': `attachment; filename="${name}"`,
  };
}

/**
 * OPS-5: the export behind the account page form. Same gate as every other
 * sensitive action (session, synchroniser token, re-authentication within
 * five minutes), then the requested window streams back as a download.
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
  });
  if (!request.ok) {
    const view = await accountView(services, authenticated, { error: request.error.message });
    return context.html(renderAccount(view), 400);
  }
  const { from, to, format } = request.value;
  services.audit.record({
    ...auditEvent(context, services, 'audit.exported', authenticated.operator.id),
    details: { format, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
  const lines = exportAuditEvents(services.database, request.value, format);
  return context.body(lines.pipeThrough(new TextEncoderStream()), 200, attachment(request.value));
}

export function registerAuditRoutes(
  app: Hono<IdentityEnvironment>,
  services: IdentityServices,
): void {
  app.post('/account/audit/export', (context) => exportAudit(context, services));
}
