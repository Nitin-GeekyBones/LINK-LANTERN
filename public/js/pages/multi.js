// Multi check: submit a list of sites, then watch the batches.
import { $, api, handleForm, html, raw, isUser, meta, num, when, host, stateBadge, toast } from '../common.js';

let pollTimer = null;

export async function init() {
  if (!isUser()) return;
  meta().then((m) => { const el = $('[data-limit=multiMaxSites]'); if (el) el.textContent = m.limits.multiMaxSites; });

  handleForm($('#multi-form'), async (data, form) => {
    await api('/api/multi', { method: 'POST', body: { urls: data.urls, mode: data.mode } });
    form.reset();
    toast('Multi check started. We will email you when every site is done.');
    load();
  });
  load();
}

async function load() {
  clearTimeout(pollTimer);
  let data;
  try { data = await api('/api/multi'); } catch (err) { $('#batches').innerHTML = html`<p class="form-error">${err.message}</p>`; return; }
  $('#outbox-note').hidden = data.mailConfigured;
  const box = $('#batches');
  if (!data.batches.length) {
    box.innerHTML = '<p class="muted">No multi checks yet. Paste a few addresses above to start one.</p>';
    return;
  }
  let busy = false;
  box.innerHTML = data.batches.map((b) => {
    const rows = b.reports.map((r) => {
      if (r.state === 'queued' || r.state === 'running') busy = true;
      const s = r.stats || {};
      return html`<tr>
        <td class="url">${host(r.startUrl)}</td>
        <td>${raw(stateBadge(r.state))}</td>
        <td>${num(s.linksChecked)}</td>
        <td>${raw(s.broken ? html`<span class="pill broken">${num(s.broken)} broken</span>` : r.state === 'done' ? '<span class="pill ok">None broken</span>' : '—')}</td>
        <td><a href="/report/${r.id}">${r.state === 'running' ? 'Watch' : 'Open report'}</a></td>
      </tr>`;
    }).join('');
    const finished = b.reports.every((r) => !['queued', 'running'].includes(r.state));
    return html`<div class="panel">
      <p><b>${num(b.reports.length)} site${b.reports.length === 1 ? '' : 's'}</b> <span class="muted small">· started ${when(b.createdAt)} · ${finished ? (b.emailedAt ? 'report emailed' : 'finished') : 'in progress'}</span></p>
      <div class="table-wrap"><table class="list"><thead><tr><th>Site</th><th>Status</th><th>Links checked</th><th>Problems</th><th></th></tr></thead><tbody>${raw(rows)}</tbody></table></div>
    </div>`;
  }).join('');
  if (busy) pollTimer = setTimeout(load, 3000);
}
