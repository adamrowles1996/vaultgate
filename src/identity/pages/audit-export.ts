import { hidden, type Html, html, when } from './template.ts';

export interface AuditExportView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
}

function exportForm(csrfToken: string): Html {
  return html`<form method="post" action="/account/audit/export">
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
    <button type="submit">Download audit log</button>
  </form>`;
}

/**
 * The account page's audit export (OPS-5). Like the other sensitive actions
 * it needs a fresh password confirmation (ID-15); until then the section
 * says so instead of offering the form.
 */
export function auditExportSection(view: AuditExportView): Html {
  return html`<section>
    <h3>Audit log</h3>
    ${when(
      !view.isReauthenticated,
      () => html`<p>Confirm your password above to export the audit log.</p>`,
    )}
    ${when(view.isReauthenticated, () => exportForm(view.csrfToken))}
  </section>`;
}
