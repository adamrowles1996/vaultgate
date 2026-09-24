import { unlockPath } from './console.ts';
import { hidden, type Html, html, when } from './template.ts';
import { cardHead } from './ui.ts';

export interface AuditExportView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
}

function exportForm(csrfToken: string): Html {
  return html`<form method="post" action="/account/audit/export" class="form-row">
    ${hidden('csrf', csrfToken)}
    <label
      >From (UTC date, inclusive)
      <input name="from" type="date" required />
    </label>
    <label
      >To (UTC date, exclusive)
      <input name="to" type="date" required />
    </label>
    <label
      >Format
      <select name="format">
        <option value="jsonl">JSON Lines</option>
        <option value="csv">CSV</option>
      </select>
    </label>
    <label
      >Log
      <select name="stream">
        <option value="audit">Audit events</option>
        <option value="actions">Action calls</option>
      </select>
    </label>
    <button type="submit" class="primary">Download</button>
  </form>`;
}

/**
 * The Activity page's audit export (OPS-5): the audit events or, as a second
 * stream over the same window, the actions layer's call trail (ACT-62). Like
 * the other sensitive actions it needs a fresh password confirmation (ID-15);
 * until then the section says so instead of offering the form.
 */
export function auditExportSection(view: AuditExportView): Html {
  return html`<section class="card" id="audit-export">
    ${cardHead(
      'Audit log',
      'Export every audit event, or every action call, for a date range as JSON Lines or CSV.',
    )}
    ${when(
      !view.isReauthenticated,
      () =>
        html`<p>
          <a href="${unlockPath('/account/activity')}">Confirm your password</a> to export the audit
          log.
        </p>`,
    )}
    ${when(view.isReauthenticated, () => exportForm(view.csrfToken))}
  </section>`;
}
